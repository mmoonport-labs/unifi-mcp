import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Udm } from './udm.js';

export type SpecApp = 'network' | 'protect';
export type Versions = Partial<Record<SpecApp, string>>;

// The OpenAPI specs are not shipped: Ubiquiti's documentation CDN and the community repo beezly/unifi-apis publish them, and this server
// fetches the one that matches the gateway's version into a cache directory the first time it sees that version.
export const specDir = (env: NodeJS.ProcessEnv): string => env.UNIFI_SPEC_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'unifi-mcp');

export interface Sources {
  cdn: (app: SpecApp, version: string) => string;
  community: (app: SpecApp, version: string) => string;
  listing: (app: SpecApp) => string;
}

export const SOURCES: Sources = {
  cdn: (app, version) => `https://apidoc-cdn.ui.com/${app}/v${version}/integration.json`,
  community: (app, version) => `https://raw.githubusercontent.com/beezly/unifi-apis/main/unifi-${app}/${version}.json`,
  listing: (app) => `https://api.github.com/repos/beezly/unifi-apis/contents/unifi-${app}`,
};

// The text of a successful answer, or undefined for anything else (a missing version is a 404).
export type Fetcher = (url: string) => Promise<string | undefined>;

export const httpFetcher: Fetcher = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'unifi-mcp' } });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
};

const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const isSpec = (value: unknown): boolean => {
  const spec = value as { paths?: unknown; components?: { schemas?: unknown } } | null;
  return typeof spec === 'object' && spec !== null && typeof spec.paths === 'object' && spec.paths !== null && typeof spec.components?.schemas === 'object';
};

// versions.json: which version each cached spec is, and `for`: the gateway version it was fetched for (they differ when the gateway
// is newer than anything published, so that start-up does not look again every time).
interface Cache extends Versions { for?: Versions }

function readCache(dir: string): Cache {
  try {
    return JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as Cache;
  } catch {
    return {};
  }
}

export function readVersions(dir: string): Versions {
  const { network, protect } = readCache(dir);
  return { ...(network === undefined ? {} : { network }), ...(protect === undefined ? {} : { protect }) };
}

// The nearest release the community repo has: the newest one that is not newer than the gateway, else the oldest one it has.
async function nearest(app: SpecApp, version: string, sources: Sources, fetcher: Fetcher): Promise<string | undefined> {
  const text = await fetcher(sources.listing(app));
  let names: Array<{ name?: unknown }> = [];
  try {
    const parsed: unknown = JSON.parse(text ?? '[]');
    // A rate-limited answer from GitHub is an object, not a list.
    if (Array.isArray(parsed)) names = parsed as typeof names;
  } catch { /* not JSON: no listing */ }
  const found = names.map((entry) => String(entry.name)).filter((name) => /^\d+(?:\.\d+)*\.json$/.test(name)).map((name) => name.slice(0, -5)).sort(compareVersions);
  return [...found].reverse().find((candidate) => compareVersions(candidate, version) <= 0) ?? found[0];
}

// The spec for that version, else for the nearest release the community repo has.
async function download(app: SpecApp, wanted: string, sources: Sources, fetcher: Fetcher): Promise<{ version: string; text: string | undefined }> {
  const exact = await fetcher(sources.cdn(app, wanted)) ?? await fetcher(sources.community(app, wanted));
  if (specText(exact)) return { version: wanted, text: exact };
  const near = await nearest(app, wanted, sources, fetcher);
  return { version: near ?? wanted, text: near === undefined || near === wanted ? undefined : await fetcher(sources.community(app, near)) };
}

export interface EnsureOptions {
  dir: string;
  gateway: Versions;
  fetcher?: Fetcher;
  sources?: Sources;
  log?: (line: string) => void;
}

// For each application whose gateway version is known and whose cached spec is for another version, download the spec for that version
// (the exact release from either source, else the nearest one the community repo has). Failing that, the cached copy, if any, is kept.
export async function ensureSpecs({ dir, gateway, fetcher = httpFetcher, sources = SOURCES, log = () => undefined }: EnsureOptions): Promise<void> {
  const cache = readCache(dir);
  for (const app of ['network', 'protect'] as const) {
    const wanted = gateway[app];
    if (wanted === undefined || cache[app] === wanted || cache.for?.[app] === wanted) continue;
    const { version, text } = await download(app, wanted, sources, fetcher);
    if (!specText(text)) {
      log(`no ${app} API spec found for ${wanted}${cache[app] === undefined ? '; its official operations are unavailable (legacy ones still work)' : `; keeping ${cache[app]}`}`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${app}.json`);
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    cache[app] = version;
    cache.for = { ...cache.for, [app]: wanted };
    writeFileSync(join(dir, 'versions.json'), `${JSON.stringify(cache, null, 2)}\n`);
    log(`${app} API spec ${version} saved to ${file}${version === wanted ? '' : ` (the gateway is ${wanted}; unknown fields in a request only warn)`}`);
  }
}

function specText(text: string | undefined): text is string {
  if (text === undefined) return false;
  try {
    return isSpec(JSON.parse(text));
  } catch {
    return false;
  }
}

export async function gatewayVersions(udm: Udm): Promise<Versions> {
  const version = async (path: string) => {
    try {
      return (await udm.get<{ applicationVersion?: string }>(path)).applicationVersion;
    } catch {
      return undefined;
    }
  };
  const [network, protect] = await Promise.all([version('/proxy/network/integration/v1/info'), version('/proxy/protect/integration/v1/meta/info')]);
  return { ...(network === undefined ? {} : { network }), ...(protect === undefined ? {} : { protect }) };
}

// Called once at start-up, before the catalog is loaded. UNIFI_SPEC_AUTO_UPDATE=0 never touches the network (for a closed network or a
// spec supplied by hand); a custom spec file also skips it.
export async function prepareSpecs(udm: Udm, env: NodeJS.ProcessEnv, log: (line: string) => void, options: Partial<EnsureOptions> = {}): Promise<void> {
  if (env.UNIFI_SPEC_AUTO_UPDATE === '0') return;
  await ensureSpecs({ dir: specDir(env), gateway: await gatewayVersions(udm), log, ...options });
}

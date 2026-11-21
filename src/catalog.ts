import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVersions, specDir } from './specs.js';
import { validate, type Findings } from './validate.js';
import type { HttpMethod } from './udm.js';

// The API as data: every operation of the official Network integration API and the official Protect integration
// API (Ubiquiti's OpenAPI documents, fetched at start-up: see specs.ts), plus a table of the legacy Network endpoints the official API does not cover.
// The tools search and run this catalog instead of registering one tool each.

export type Risk = 'read' | 'write' | 'delete';

export interface Param {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: Record<string, unknown>;
}

export type App = 'network' | 'protect';

export interface Operation {
  id: string;
  app: App;
  api: 'official' | 'legacy';
  method: HttpMethod;
  // Official: the full path on the gateway. Legacy: relative to /proxy/network/api/s/<site>/, or, when it starts with v2/, to /proxy/network/v2/api/site/<site>/.
  path: string;
  summary: string;
  description: string;
  tags: string[];
  params: Param[];
  hasBody: boolean;
  bodyRequired: boolean;
  bodySchema?: unknown;
  // What the answer is: JSON, or an image (a camera snapshot).
  response: 'json' | 'image';
  // Why this server cannot run it (a WebSocket stream, a file upload); it is listed so it can be found and explained.
  unsupported?: string;
  risk: Risk;
  // A command the server sends itself (the speed test): the caller passes no body.
  fixedBody?: Record<string, unknown>;
  // Legacy PUT replaces the whole object, so the caller's fields are merged over the current row before sending.
  merge?: boolean;
}

type Json = Record<string, unknown>;

interface Spec {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, unknown>; parameters?: Record<string, unknown> };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const BASES: Record<App, string> = { network: '/proxy/network/integration', protect: '/proxy/protect/integration' };
// An action that cannot be undone ('Permanently disable camera microphone') goes through the delete tool, whatever its method.
const riskOf = (method: HttpMethod, summary: string): Risk => (method === 'GET' ? 'read' : method === 'DELETE' || /permanent/i.test(summary) ? 'delete' : 'write');

// The specs are fetched at start-up into a cache directory (see specs.ts); UNIFI_SPEC_FILE / UNIFI_PROTECT_SPEC_FILE swap in another
// copy (a newer download, or one corrected by hand). An application with no spec has no official operations, but its legacy ones remain.
const EMPTY: Spec = { paths: {}, components: { schemas: {} } };
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const cached = (name: string): unknown => { try { return readJson(join(specDir(process.env), name)); } catch { return undefined; } };
const load = (override: string | undefined, name: string): Spec => (override === undefined ? cached(name) as Spec | undefined : readJson(override) as Spec) ?? EMPTY;
const spec = load(process.env.UNIFI_SPEC_FILE, 'network.json');
const protectSpec = load(process.env.UNIFI_PROTECT_SPEC_FILE, 'protect.json');
const ROOTS: Record<App, Spec> = { network: spec, protect: protectSpec };
// Which version each spec is: recorded beside the cache (Protect's own text says 0.0.0).
const recorded = readVersions(specDir(process.env));
export const SPEC_VERSIONS: Record<App, string> = {
  network: process.env.UNIFI_SPEC_FILE === undefined ? recorded.network ?? 'none' : 'custom',
  protect: process.env.UNIFI_PROTECT_SPEC_FILE === undefined ? recorded.protect ?? 'none' : 'custom',
};

function lookup(ref: string, root: unknown): unknown {
  return ref.slice(2).split('/').map((part) => decodeURIComponent(part)).reduce<unknown>((node, key) => (node as Json)[key], root);
}

// Replace every $ref with what it points to, so one answer is the whole schema. A reference to something already being expanded
// (a recursive schema) and anything past the depth limit is left as a name rather than followed.
export function deref(node: unknown, root: unknown = spec, seen: string[] = [], depth = 0): unknown {
  if (Array.isArray(node)) return node.map((item) => deref(item, root, seen, depth));
  if (typeof node !== 'object' || node === null) return node;
  const object = node as Json;
  if (typeof object.$ref === 'string') {
    const ref = object.$ref;
    if (seen.includes(ref) || depth > 8) return { $ref: ref.split('/').pop() };
    return deref(lookup(ref, root), root, [...seen, ref], depth + 1);
  }
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, deref(value, root, seen, depth)]));
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Protect's spec has no operationIds: the id is its summary ("Get all viewers" is protect_get_all_viewers), which is unique there.
const idOf = (app: App, op: Json) => (app === 'protect' ? `protect_${slug(op.summary as string)}` : (op.operationId as string));

function unsupportedReason(app: App, path: string, requestBody: { content: Record<string, unknown> } | undefined): string | undefined {
  if (app === 'protect' && path.startsWith('/v1/subscribe/')) return 'a WebSocket stream, which this server cannot open';
  if (requestBody !== undefined && !('application/json' in requestBody.content)) return 'a file upload, which this server cannot send';
  return undefined;
}

function officialOperations(app: App): Operation[] {
  const root = ROOTS[app];
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(root.paths)) {
    for (const verb of METHODS) {
      const op = item[verb];
      if (op === undefined) continue;
      const method = verb.toUpperCase() as HttpMethod;
      const declared = (op.parameters as Json[] | undefined) ?? [];
      const params = declared.map((raw) => deref(raw, root) as Json).filter((p) => p.in === 'path' || p.in === 'query').map((p): Param => ({
        name: p.name as string,
        in: p.in as 'path' | 'query',
        required: p.required === true,
        schema: p.schema as Json,
      }));
      const requestBody = op.requestBody as { required?: boolean; content: Record<string, { schema: unknown }> } | undefined;
      const ok = (op.responses as Record<string, { content?: Record<string, unknown> }>)['200'];
      operations.push({
        id: idOf(app, op),
        app,
        api: 'official',
        method,
        path: `${BASES[app]}${path}`,
        summary: op.summary as string,
        description: (op.description as string | undefined) ?? '',
        tags: op.tags as string[],
        params,
        hasBody: requestBody !== undefined,
        bodyRequired: requestBody?.required === true,
        bodySchema: requestBody?.content['application/json'] === undefined ? undefined : deref(requestBody.content['application/json'].schema, root),
        response: Object.keys(ok?.content ?? {}).some((type) => type.startsWith('image/')) ? 'image' : 'json',
        unsupported: unsupportedReason(app, path, requestBody),
        risk: riskOf(method, op.summary as string),
      });
    }
  }
  return operations;
}

// The legacy API: the same data the UniFi web app uses, no published spec. Only the endpoints worth having are listed; each row
// is a free-form object (read it with the list operation to see the fields).
const LEGACY_RESOURCES: Array<[name: string, endpoint: string, label: string]> = [
  ['port_forward', 'rest/portforward', 'port-forward rule'],
  ['network', 'rest/networkconf', 'network / VLAN'],
  ['firewall_rule', 'rest/firewallrule', 'firewall rule'],
  ['firewall_group', 'rest/firewallgroup', 'firewall address/port group'],
  ['wlan', 'rest/wlanconf', 'Wi-Fi network (SSID)'],
  ['client_config', 'rest/user', 'known client (name, fixed IP / DHCP reservation, note)'],
  ['user_group', 'rest/usergroup', 'client bandwidth group'],
  ['port_profile', 'rest/portconf', 'switch port profile'],
  ['static_route', 'rest/routing', 'static route'],
  ['dynamic_dns', 'rest/dynamicdns', 'dynamic DNS entry'],
];

const LEGACY_STATS: Array<[name: string, endpoint: string, summary: string]> = [
  ['health', 'stat/health', 'site health by subsystem'],
  ['devices', 'stat/device', 'adopted devices, full records'],
  ['clients', 'stat/sta', 'connected clients, full records'],
  ['all_clients', 'stat/alluser', 'every client ever seen'],
  ['events', 'stat/event', 'recent events (removed from newer Network versions: a 404 means this gateway no longer has it)'],
  ['sysinfo', 'stat/sysinfo', 'controller system information'],
  ['routing', 'stat/routing', 'active routes'],
  ['settings', 'get/setting', 'all site settings'],
  ['rogue_aps', 'stat/rogueap', 'neighbouring access points seen by the radios (rogue AP scan)'],
  ['current_channels', 'stat/current-channel', 'the channels this site may use, per band, for its country'],
  ['dpi', 'stat/dpi', 'deep packet inspection totals'],
  ['client_dpi', 'stat/stadpi', 'deep packet inspection per client'],
  ['vouchers', 'stat/voucher', 'hotspot vouchers'],
  ['guests', 'stat/guest', 'guest clients'],
  ['guest_authorizations', 'stat/authorization', 'guest authorizations'],
  ['country_codes', 'stat/ccode', 'country codes'],
];

// Lists that are only read here: their writes have not been tried on a real gateway.
const LEGACY_READ_ONLY: Array<[name: string, endpoint: string, label: string]> = [
  ['hotspot_operator', 'rest/hotspotop', 'hotspot operator'],
  ['hotspot_package', 'rest/hotspotpackage', 'hotspot package'],
  ['radius_profile', 'rest/radiusprofile', 'RADIUS profile'],
  ['radius_account', 'rest/account', 'RADIUS account'],
  ['wlan_group', 'rest/wlangroup', 'Wi-Fi group'],
  ['scheduled_task', 'rest/scheduletask', 'scheduled task'],
  ['dpi_app', 'rest/dpiapp', 'custom DPI application'],
  ['dpi_group', 'rest/dpigroup', 'DPI group'],
];

// The newer "v2" API (/proxy/network/v2/api/site/<site>/...), read only: it answers with a bare list, not {meta, data}.
const V2_READS: Array<[name: string, endpoint: string, label: string]> = [
  ['traffic_rules', 'trafficrules', 'traffic rule'],
  ['traffic_routes', 'trafficroutes', 'traffic route'],
  ['static_dns', 'static-dns', 'static DNS record'],
  ['ap_groups', 'apgroups', 'access point group'],
  ['nat_rules', 'nat', 'NAT rule'],
  ['acl_rules', 'acl-rules', 'switch ACL rule'],
  ['qos_rules', 'qos-rules', 'QoS rule'],
];

function legacyOperations(): Operation[] {
  const id: Param = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const base = { app: 'network' as const, api: 'legacy' as const, tags: ['Legacy'], response: 'json' as const, bodySchema: { type: 'object', description: 'free-form; read the row with the list operation first' } };
  const operations: Operation[] = LEGACY_STATS.map(([name, endpoint, summary]) => ({
    ...base, id: `legacy_get_${name}`, method: 'GET', path: endpoint, summary: `Read ${summary} (legacy API).`, description: '',
    params: [], hasBody: false, bodyRequired: false, risk: 'read', bodySchema: undefined,
  }));
  const read = (id: string, path: string, label: string, tags: string[]): Operation => ({
    ...base, id, method: 'GET', path, summary: `List every ${label}.`, description: '', params: [], hasBody: false, bodyRequired: false, risk: 'read', bodySchema: undefined, tags,
  });
  for (const [name, endpoint, label] of LEGACY_READ_ONLY) operations.push(read(`legacy_list_${name}`, endpoint, `${label} (legacy API)`, ['Legacy']));
  for (const [name, endpoint, label] of V2_READS) operations.push(read(`v2_list_${name}`, `v2/${endpoint}`, `${label} (v2 API)`, ['Legacy', 'v2']));
  for (const [name, endpoint, label] of LEGACY_RESOURCES) {
    operations.push(
      { ...base, id: `legacy_list_${name}`, method: 'GET', path: endpoint, summary: `List every ${label} (legacy API).`, description: '', params: [], hasBody: false, bodyRequired: false, risk: 'read', bodySchema: undefined },
      { ...base, id: `legacy_create_${name}`, method: 'POST', path: endpoint, summary: `Create a ${label} (legacy API).`, description: '', params: [], hasBody: true, bodyRequired: true, risk: 'write' },
      { ...base, id: `legacy_update_${name}`, method: 'PUT', path: `${endpoint}/{id}`, summary: `Change a ${label}: send only the fields to change, they are merged over the current row (legacy API).`, description: '', params: [id], hasBody: true, bodyRequired: true, risk: 'write', merge: true },
      { ...base, id: `legacy_delete_${name}`, method: 'DELETE', path: `${endpoint}/{id}`, summary: `Delete a ${label} (legacy API).`, description: '', params: [id], hasBody: false, bodyRequired: false, risk: 'delete', bodySchema: undefined },
    );
  }
  operations.push(
    { ...base, id: 'legacy_device_command', method: 'POST', path: 'cmd/devmgr', summary: 'Run a device command such as restart, provision or locate: body {cmd, mac} (legacy API).', description: '', params: [], hasBody: true, bodyRequired: true, risk: 'write' },
    // The speed test is a command to the device manager. Its body is fixed here so the read (status) and the write (start) cannot be mixed up.
    { ...base, id: 'legacy_get_speedtest_status', method: 'POST', path: 'cmd/devmgr', summary: 'Read the state and result of the latest speed test: xput_download and xput_upload in Mbps, latency in ms; status_summary was seen as 0 not started, 1 running, 2 finished (legacy API). Sends the command speedtest-status; it does not start a test.', description: '', params: [], hasBody: false, bodyRequired: false, risk: 'read', bodySchema: undefined, fixedBody: { cmd: 'speedtest-status' } },
    { ...base, id: 'legacy_start_speedtest', method: 'POST', path: 'cmd/devmgr', summary: 'Start a speed test of the internet connection (legacy API). It uses the whole WAN link for about 15 to 30 seconds. It takes no body; read the result with legacy_get_speedtest_status.', description: '', params: [], hasBody: false, bodyRequired: false, risk: 'write', bodySchema: undefined, fixedBody: { cmd: 'speedtest' } },
    { ...base, id: 'legacy_client_command', method: 'POST', path: 'cmd/stamgr', summary: 'Run a client command such as block-sta, unblock-sta or kick-sta: body {cmd, mac} (legacy API).', description: '', params: [], hasBody: true, bodyRequired: true, risk: 'write' },
  );
  return operations;
}

export const OPERATIONS: readonly Operation[] = [...officialOperations('network'), ...officialOperations('protect'), ...legacyOperations()];
const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

// Errors and warnings for a request body against the operation's schema (official operations only: the legacy bodies are free-form).
export const validateBody = (op: Operation, body: unknown): Findings => (op.bodySchema === undefined ? { errors: [], warnings: [] } : validate(op.bodySchema, body, (ref) => deref({ $ref: ref }, ROOTS[op.app])));

// Is there a GET on the same path (the record a PATCH, PUT or DELETE there acts on)?
export const hasGet = (op: Operation): boolean => OPERATIONS.some((other) => other.method === 'GET' && other.path === op.path);

export const findOperation = (id: string): Operation | undefined => BY_ID.get(id);

export interface Summary {
  id: string; app: App; api: string; method: string; path: string; summary: string; risk: Risk; tags: string[]; unsupported?: string;
}

const summarise = (op: Operation): Summary => ({ id: op.id, app: op.app, api: op.api, method: op.method, path: op.path, summary: op.summary, risk: op.risk, tags: op.tags, unsupported: op.unsupported });

// Keyword search over id, summary, path and tags: every word must appear somewhere; best (most words in the id and summary) first.
export function search(query: string | undefined, filter: { tag?: string; risk?: Risk; api?: 'official' | 'legacy'; app?: App }, limit: number): { total: number; operations: Summary[] } {
  const words = (query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = OPERATIONS
    .filter((op) => (filter.tag === undefined || op.tags.some((tag) => tag.toLowerCase() === filter.tag!.toLowerCase())) && (filter.risk === undefined || op.risk === filter.risk) && (filter.api === undefined || op.api === filter.api) && (filter.app === undefined || op.app === filter.app))
    .map((op) => {
      const head = `${op.id} ${op.summary}`.toLowerCase();
      const all = `${head} ${op.path.replace(/^\/proxy\/(?:network|protect)\/integration/, '')} ${op.tags.join(' ')}`.toLowerCase();
      return { op, score: words.every((word) => all.includes(word)) ? words.filter((word) => head.includes(word)).length : -1 };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);
  return { total: scored.length, operations: scored.slice(0, limit).map((entry) => summarise(entry.op)) };
}

export const tags = (): string[] => [...new Set(OPERATIONS.flatMap((op) => op.tags))].sort();

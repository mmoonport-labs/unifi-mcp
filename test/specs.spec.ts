import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compareVersions, ensureSpecs, gatewayVersions, httpFetcher, prepareSpecs, readVersions, SOURCES, specDir, type Fetcher } from '../src/specs.js';
import { Udm } from '../src/udm.js';
import { fakeUdm } from './fake-udm.js';

const SPEC = JSON.stringify({ paths: {}, components: { schemas: {} } });
const dir = () => mkdtempSync(join(tmpdir(), 'specs-'));
const answers = (table: Record<string, string>): Fetcher => async (url) => table[url];
const lines = () => { const out: string[] = []; return { out, log: (line: string) => { out.push(line); } }; };

describe('where specs are kept', () => {
  it('uses UNIFI_SPEC_DIR, then the XDG cache, then ~/.cache', () => {
    expect(specDir({ UNIFI_SPEC_DIR: '/s' })).toBe('/s');
    expect(specDir({ XDG_CACHE_HOME: '/x' })).toBe(join('/x', 'unifi-mcp'));
    expect(specDir({})).toMatch(/\.cache[\\/]unifi-mcp$/);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('10.3.58', '9.0.99')).toBeGreaterThan(0);
    expect(compareVersions('11.0', '11.0.0')).toBe(0);
    expect(compareVersions('7.3.74', '7.4.102')).toBeLessThan(0);
    expect(compareVersions('x.1', '0.1')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1')).toBeGreaterThan(0);
  });

  it('reads no versions from a missing or broken file', () => {
    const d = dir();
    expect(readVersions(d)).toEqual({});
    writeFileSync(join(d, 'versions.json'), 'nope');
    expect(readVersions(d)).toEqual({});
  });
});

describe('ensureSpecs', () => {
  it('downloads the exact version from the CDN and records it', async () => {
    const d = dir();
    const { out, log } = lines();
    await ensureSpecs({ dir: join(d, 'sub'), gateway: { protect: '7.3.74' }, log, fetcher: answers({ [SOURCES.cdn('protect', '7.3.74')]: SPEC }) });
    expect(readFileSync(join(d, 'sub', 'protect.json'), 'utf8')).toBe(SPEC);
    expect(readVersions(join(d, 'sub'))).toEqual({ protect: '7.3.74' });
    expect(out[0]).toMatch(/protect API spec 7\.3\.74 saved/);
  });

  it('falls back to the community repo for that version', async () => {
    const d = dir();
    await ensureSpecs({ dir: d, gateway: { network: '11.0.99' }, fetcher: answers({ [SOURCES.community('network', '11.0.99')]: SPEC }) });
    expect(readVersions(d)).toEqual({ network: '11.0.99' });
  });

  it('does nothing for a version it already has, or one the gateway did not report', async () => {
    const d = dir();
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ network: '11.0.99' }));
    const fetcher = vi.fn<Fetcher>(async () => SPEC);
    await ensureSpecs({ dir: d, gateway: { network: '11.0.99' }, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('takes the newest older release when the gateway is newer than anything published, and says so', async () => {
    const d = dir();
    const { out, log } = lines();
    await ensureSpecs({
      dir: d, gateway: { network: '11.2.0' }, log,
      fetcher: answers({
        [SOURCES.listing('network')]: JSON.stringify([{ name: '9.0.99.json' }, { name: '11.1.50.json' }, { name: '11.1.9.json' }, { name: 'README.md' }]),
        [SOURCES.community('network', '11.1.50')]: SPEC,
      }),
    });
    expect(readVersions(d)).toEqual({ network: '11.1.50' });
    expect(out[0]).toContain('the gateway is 11.2.0');
    const again = vi.fn<Fetcher>(async () => undefined);
    await ensureSpecs({ dir: d, gateway: { network: '11.2.0' }, fetcher: again });
    expect(again).not.toHaveBeenCalled();
  });

  it('takes the oldest release when the gateway is older than all of them', async () => {
    const d = dir();
    await ensureSpecs({
      dir: d, gateway: { network: '8.0.0' },
      fetcher: answers({ [SOURCES.listing('network')]: JSON.stringify([{ name: '9.0.99.json' }, { name: '10.0.0.json' }]), [SOURCES.community('network', '9.0.99')]: SPEC }),
    });
    expect(readVersions(d)).toEqual({ network: '9.0.99' });
  });

  it('rejects text that is not a spec, and says what is unavailable', async () => {
    const d = dir();
    const { out, log } = lines();
    await ensureSpecs({ dir: d, gateway: { network: '11.0.99' }, log, fetcher: answers({ [SOURCES.cdn('network', '11.0.99')]: '<html>', [SOURCES.listing('network')]: 'not json' }) });
    expect(existsSync(join(d, 'network.json'))).toBe(false);
    expect(out).toEqual(['no network API spec found for 11.0.99; its official operations are unavailable (legacy ones still work)']);
    await ensureSpecs({ dir: d, gateway: { network: '11.0.99' }, fetcher: answers({ [SOURCES.cdn('network', '11.0.99')]: 'null', [SOURCES.listing('network')]: '{}' }) });
    await ensureSpecs({ dir: d, gateway: { network: '11.0.99' }, fetcher: answers({ [SOURCES.cdn('network', '11.0.99')]: '{"paths":{}}' }) });
  });

  it('keeps the cached spec when no other can be found', async () => {
    const d = dir();
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ protect: '7.3.0' }));
    const { out, log } = lines();
    await ensureSpecs({ dir: d, gateway: { protect: '7.4.0' }, log, fetcher: answers({}) });
    expect(out).toEqual(['no protect API spec found for 7.4.0; keeping 7.3.0']);
    expect(readVersions(d)).toEqual({ protect: '7.3.0' });
  });

  it('does not re-download when the nearest release is the version it already has', async () => {
    const d = dir();
    const fetcher = vi.fn<Fetcher>(async (url) => (url === SOURCES.listing('protect') ? JSON.stringify([{ name: '7.4.0.json' }]) : undefined));
    await ensureSpecs({ dir: d, gateway: { protect: '7.4.0' }, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('the HTTP fetcher', () => {
  it('returns the text of a good answer and nothing for a bad one or a failure', async () => {
    const fake = await fakeUdm({ 'GET /ok': () => ({ status: 200, body: 'hello' }), 'GET /gone': () => ({ status: 404 }) });
    try {
      expect(await httpFetcher(`${fake.url}/ok`)).toBe('hello');
      expect(await httpFetcher(`${fake.url}/gone`)).toBeUndefined();
    } finally {
      await fake.close();
    }
    expect(await httpFetcher('http://127.0.0.1:1/')).toBeUndefined();
  });
});

describe('start-up', () => {
  it('reads the gateway versions it can get', async () => {
    const fake = await fakeUdm({ 'GET /proxy/network/integration/v1/info': () => ({ status: 200, body: JSON.stringify({ applicationVersion: '11.0.99' }) }), 'GET /proxy/protect/integration/v1/meta/info': () => ({ status: 500 }) });
    try {
      expect(await gatewayVersions(new Udm({ baseUrl: fake.url, apiKey: 'k' }))).toEqual({ network: '11.0.99' });
    } finally {
      await fake.close();
    }
  });

  it('reads only the protect version when that is all there is', async () => {
    const fake = await fakeUdm({ 'GET /proxy/network/integration/v1/info': () => ({ status: 404 }), 'GET /proxy/protect/integration/v1/meta/info': () => ({ status: 200, body: JSON.stringify({ applicationVersion: '7.3.74' }) }) });
    try {
      expect(await gatewayVersions(new Udm({ baseUrl: fake.url, apiKey: 'k' }))).toEqual({ protect: '7.3.74' });
    } finally {
      await fake.close();
    }
  });

  it('reads both, fetches what is missing, and can be switched off', async () => {
    const fake = await fakeUdm({ 'GET /proxy/network/integration/v1/info': () => ({ status: 200, body: JSON.stringify({ applicationVersion: '11.0.99' }) }) });
    try {
      const udm = new Udm({ baseUrl: fake.url, apiKey: 'k' });
      const d = dir();
      await prepareSpecs(udm, { UNIFI_SPEC_DIR: d, UNIFI_SPEC_AUTO_UPDATE: '0' }, () => undefined, { fetcher: answers({ [SOURCES.cdn('network', '11.0.99')]: SPEC }) });
      expect(readVersions(d)).toEqual({});
      await prepareSpecs(udm, { UNIFI_SPEC_DIR: d }, () => undefined, { fetcher: answers({ [SOURCES.cdn('network', '11.0.99')]: SPEC, [SOURCES.cdn('protect', '7.3.74')]: SPEC }) });
      expect(readVersions(d)).toEqual({ network: '11.0.99', protect: '7.3.74' });
    } finally {
      await fake.close();
    }
  });
});

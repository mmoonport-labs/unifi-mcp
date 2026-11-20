import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPEC_VERSIONS } from '../src/catalog.js';
import { createServer, isPortSpec, isPrivateIpv4, type ServerOptions } from '../src/tools.js';
import { Udm } from '../src/udm.js';
import { fakeUdm, RULE_ID, UUID_RULE_ID } from './fake-udm.js';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

async function connect(options: ServerOptions = {}, overrides = {}) {
  const fake = await fakeUdm(overrides);
  const server = createServer(new Udm({ baseUrl: fake.url, apiKey: 'k' }), options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(fake.close, () => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { error: r.isError === true, text: r.content[0]!.text };
  };
  return { fake, call, client };
}

describe('read tools', () => {
  it('lists exactly the tools', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['unifi_call', 'unifi_delete', 'unifi_describe_operation', 'unifi_health', 'unifi_info', 'unifi_list_clients', 'unifi_list_devices', 'unifi_list_port_forwards', 'unifi_search_api', 'unifi_set_port_forward', 'unifi_write']);
  });
  it('returns only the chosen fields', async () => {
    const { call } = await connect();
    const rules = JSON.parse((await call('unifi_list_port_forwards')).text);
    expect(rules[0]).toMatchObject({ _id: RULE_ID, dst_port: '443', fwd: '192.168.50.206' });
    expect(rules[0]).not.toHaveProperty('site_id');
    expect((await call('unifi_info')).text).toContain('10.6.109');
    expect(JSON.parse((await call('unifi_health')).text)[0]).not.toHaveProperty('secret');
    expect(JSON.parse((await call('unifi_list_devices')).text)[0]).toEqual({ name: 'UDM', model: 'UDMPRO', type: 'udm' });
    expect(JSON.parse((await call('unifi_list_clients')).text)[0]).not.toHaveProperty('icon_filename');
  });
  it('turns a gateway failure into a tool error', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/integration/v1/info': () => ({ status: 500 }) });
    expect(await call('unifi_info')).toMatchObject({ error: true });
  });
  it('rethrows what is not a gateway error', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/api/s/default/stat/health': () => ({ status: 200, body: '{"data":5}' }) });
    expect((await call('unifi_health')).error).toBe(true);
  });
  it('treats an answer with no data as empty', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/api/s/default/stat/sta': () => ({ status: 200, body: '{}' }) });
    expect((await call('unifi_list_clients')).text).toBe('[]');
  });
});

describe('unifi_info and spec drift', () => {
  const NETWORK = '/proxy/network/integration/v1/info';
  const PROTECT = '/proxy/protect/integration/v1/meta/info';
  const info = async (overrides = {}) => JSON.parse((await (await connect({}, overrides)).call('unifi_info')).text);

  it('reports the gateway versions, the spec versions and the apps that differ', async () => {
    const r = await info({ [`GET ${NETWORK}`]: () => ({ status: 200, body: '{"applicationVersion":"99.1.1"}' }) });
    expect(r.specs).toEqual(SPEC_VERSIONS);
    expect(r.protect).toEqual({ applicationVersion: '7.3.74' });
    expect(r.specDrift).toEqual([{ app: 'network', gateway: '99.1.1', spec: SPEC_VERSIONS.network }, ...(SPEC_VERSIONS.protect === '7.3.74' ? [] : [{ app: 'protect', gateway: '7.3.74', spec: SPEC_VERSIONS.protect }])]);
  });
  it('reports no drift when both match, and none for an app that is not there', async () => {
    const same = await info({ [`GET ${NETWORK}`]: () => ({ status: 200, body: JSON.stringify({ applicationVersion: SPEC_VERSIONS.network }) }), [`GET ${PROTECT}`]: () => ({ status: 200, body: JSON.stringify({ applicationVersion: SPEC_VERSIONS.protect }) }) });
    expect(same.specDrift).toEqual([]);
    const none = await info({ [`GET ${NETWORK}`]: () => ({ status: 200, body: JSON.stringify({ applicationVersion: SPEC_VERSIONS.network }) }), [`GET ${PROTECT}`]: () => ({ status: 404 }) });
    expect(none.protect).toBeNull();
    expect(none.specDrift).toEqual([]);
  });
  it('leaves a spec you supplied yourself alone, and an answer without a version', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'spec-')), 'protect.json');
    writeFileSync(file, JSON.stringify({ components: { schemas: {} }, paths: {} }));
    process.env.UNIFI_PROTECT_SPEC_FILE = file;
    vi.resetModules();
    try {
      const tools = await import('../src/tools.js');
      const udm = await import('../src/udm.js');
      const fake = await fakeUdm({ [`GET ${PROTECT}`]: () => ({ status: 200, body: '{"applicationVersion":"1.2.3"}' }), [`GET ${NETWORK}`]: () => ({ status: 200, body: '{}' }) });
      cleanup.push(fake.close);
      const server = tools.createServer(new udm.Udm({ baseUrl: fake.url, apiKey: 'k' }));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      cleanup.push(() => client.close());
      const r = JSON.parse(((await client.callTool({ name: 'unifi_info', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text);
      expect(r.specs.protect).toBe('custom');
      expect(r.specDrift).toEqual([]);
    } finally {
      delete process.env.UNIFI_PROTECT_SPEC_FILE;
      vi.resetModules();
    }
  });
});

describe('unifi_set_port_forward', () => {
  const change = { id: RULE_ID, fwd: '192.168.50.223' };

  it('refuses when the server is read-only', async () => {
    const { call, fake } = await connect({ readOnly: true });
    expect(await call('unifi_set_port_forward', { ...change, dry_run: false, confirm: true })).toMatchObject({ error: true, text: expect.stringContaining('UNIFI_READ_ONLY=1') });
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('defaults to a dry run that changes nothing', async () => {
    const { call, fake } = await connect({});
    const r = JSON.parse((await call('unifi_set_port_forward', change)).text);
    expect(r).toMatchObject({ dryRun: true, before: { fwd: '192.168.50.206' }, after: { fwd: '192.168.50.223' } });
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('needs confirm=true as well as dry_run=false', async () => {
    const { call, fake } = await connect({});
    expect(await call('unifi_set_port_forward', { ...change, dry_run: false })).toMatchObject({ error: true, text: expect.stringContaining('confirm=true') });
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('applies, keeps every other field, audits, and says how to revert', async () => {
    const audit: string[] = [];
    const { call, fake } = await connect({ audit: (l) => audit.push(l) });
    const r = JSON.parse((await call('unifi_set_port_forward', { ...change, enabled: false, dry_run: false, confirm: true })).text);
    expect(r).toMatchObject({ applied: true, revert: { id: RULE_ID, enabled: true, fwd: '192.168.50.206', dry_run: false, confirm: true } });
    const put = fake.seen.find((s) => s.method === 'PUT')!;
    expect(JSON.parse(put.body)).toMatchObject({ _id: RULE_ID, name: 'Furia Stream Port 443', fwd: '192.168.50.223', enabled: false, dst_port: '443' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).not.toContain('"k"');
  });
  it('works with the default audit', async () => {
    const { call } = await connect({});
    expect((await call('unifi_set_port_forward', { ...change, dst_port: '8443', fwd_port: '443', dry_run: false, confirm: true })).error).toBe(false);
  });
  it('accepts the UUID ids the gateway uses since 2026-11-12 (FS-308)', async () => {
    const { call, fake } = await connect({});
    const dry = JSON.parse((await call('unifi_set_port_forward', { id: UUID_RULE_ID, fwd: '192.168.50.223' })).text);
    expect(dry).toMatchObject({ dryRun: true, rule: 'Furia Stream Port 1936', before: { fwd: '192.168.50.206' }, after: { fwd: '192.168.50.223' } });
    const applied = JSON.parse((await call('unifi_set_port_forward', { id: UUID_RULE_ID, enabled: false, dry_run: false, confirm: true })).text);
    expect(applied).toMatchObject({ applied: true, revert: { id: UUID_RULE_ID, enabled: true, dry_run: false, confirm: true } });
    expect(fake.seen.filter((s) => s.method === 'PUT').map((s) => s.url)).toEqual([`/proxy/network/api/s/default/rest/portforward/${UUID_RULE_ID}`]);
  });
  it('rejects ids that are not a 24-hex id or a lowercase UUID, so nothing odd reaches the request path', async () => {
    const { call, fake } = await connect({});
    for (const id of ['../x', 'b4230af0-d6b2-49cd-accf-3d434a294f7', 'B4230AF0-D6B2-49CD-ACCF-3D434A294F73', `${UUID_RULE_ID}/x`, 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      expect(await call('unifi_set_port_forward', { id, enabled: false })).toMatchObject({ error: true });
    }
    expect(fake.seen).toHaveLength(0);
  });
  it('refuses bad input before touching the gateway', async () => {
    const { call, fake } = await connect({});
    expect((await call('unifi_set_port_forward', { id: RULE_ID })).text).toContain('Nothing to change');
    expect((await call('unifi_set_port_forward', { id: RULE_ID, fwd: '8.8.8.8' })).text).toContain('private LAN');
    expect((await call('unifi_set_port_forward', { id: RULE_ID, fwd_port: '70000' })).text).toContain('fwd_port');
    expect((await call('unifi_set_port_forward', { id: RULE_ID, dst_port: 'x' })).text).toContain('dst_port');
    expect(fake.seen).toHaveLength(0);
  });
  it('refuses an unknown rule, and reports a failed write', async () => {
    const { call } = await connect({}, { [`PUT /proxy/network/api/s/default/rest/portforward/${RULE_ID}`]: () => ({ status: 400 }) });
    expect((await call('unifi_set_port_forward', { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', enabled: false })).text).toContain('No port-forward rule');
    expect(await call('unifi_set_port_forward', { ...change, dry_run: false, confirm: true })).toMatchObject({ error: true, text: expect.stringContaining('400') });
  });
  it('reports a read failure while writing', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/api/s/default/rest/portforward': () => ({ status: 500 }) });
    expect((await call('unifi_set_port_forward', change)).error).toBe(true);
  });
  it('rethrows a non-gateway failure', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/api/s/default/rest/portforward': () => ({ status: 200, body: '{"data":5}' }) });
    expect((await call('unifi_set_port_forward', change)).error).toBe(true);
  });
});

describe('validators', () => {
  it('private IPv4', () => {
    for (const ok of ['10.0.0.1', '172.16.0.1', '172.31.9.9', '192.168.50.223']) expect(isPrivateIpv4(ok)).toBe(true);
    for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '1.2.3', '10.0.0.256', 'a.b.c.d', '']) expect(isPrivateIpv4(bad)).toBe(false);
  });
  it('port specs', () => {
    for (const ok of ['1', '443', '65535', '8000-8010']) expect(isPortSpec(ok)).toBe(true);
    for (const bad of ['0', '65536', '8010-8000', '1-2-3', 'x', '', '80-']) expect(isPortSpec(bad)).toBe(false);
  });
});

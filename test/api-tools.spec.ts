import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_REPLY_CHARS, REDACTED, redact, trim, type ApiToolOptions } from '../src/api-tools.js';
import { deref, findOperation, OPERATIONS, search } from '../src/catalog.js';
import { createServer } from '../src/tools.js';
import { Udm } from '../src/udm.js';
import { fakeUdm, UUID_RULE_ID } from './fake-udm.js';

const SITE = '88f7af54-98f8-306a-a1c7-c9349722b1f6';
const ZONE = '11111111-2222-3333-4444-555555555555';
const OFFICIAL = `/proxy/network/integration/v1/sites/${SITE}`;
const LEGACY = '/proxy/network/api/s/default/';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

async function connect(options: ApiToolOptions = {}, overrides = {}) {
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

const ok = (body: unknown) => () => ({ status: 200, body: JSON.stringify(body) });
const sites = ok({ data: [{ id: SITE, name: 'Default', internalReference: 'default' }] });

describe('catalog', () => {
  it('has every official operation and the legacy table, with unique ids', () => {
    expect(OPERATIONS.filter((o) => o.app === 'network' && o.api === 'official').length).toBeGreaterThanOrEqual(73);   // a refreshed spec may add operations
    expect(OPERATIONS.filter((o) => o.app === 'protect').length).toBeGreaterThanOrEqual(74);
    expect(new Set(OPERATIONS.map((o) => o.id)).size).toBe(OPERATIONS.length);
    expect(findOperation('createFirewallZone')).toMatchObject({ method: 'POST', risk: 'write', hasBody: true });
    expect(findOperation('nope')).toBeUndefined();
  });
  it('searches by words, tag, risk and api', () => {
    expect(search('firewall zone', {}, 5).operations.length).toBeGreaterThan(0);
    expect(search('zzzz', {}, 5).total).toBe(0);
    expect(search('proxy', {}, 5).total).toBe(0);   // the common path prefix is not searchable
    expect(search(undefined, { risk: 'delete', api: 'legacy' }, 100).operations.every((o) => o.risk === 'delete' && o.api === 'legacy')).toBe(true);
    expect(search(undefined, { tag: 'legacy' }, 100).operations.every((o) => o.api === 'legacy')).toBe(true);
  });
  it('expands references, and stops at one that points back at itself', () => {
    expect(deref([{ a: 1 }, 'x', null])).toEqual([{ a: 1 }, 'x', null]);
    expect(JSON.stringify(findOperation('createFirewallZone')!.bodySchema)).not.toContain('$ref');
    const root = { a: { b: { $ref: '#/a' } }, deep: { $ref: '#/deep' } };
    expect(deref({ $ref: '#/a' }, root)).toEqual({ b: { $ref: 'a' } });
    expect(deref({ $ref: '#/deep' }, root)).toEqual({ $ref: 'deep' });
  });
});

describe('the Protect catalog', () => {
  it('names operations from their summaries, and says what this server cannot run', () => {
    expect(findOperation('protect_get_all_cameras')).toMatchObject({ app: 'protect', method: 'GET', path: '/proxy/protect/integration/v1/cameras' });
    expect(OPERATIONS.filter((o) => o.unsupported).map((o) => o.id)).toEqual(expect.arrayContaining(['protect_get_protect_event_messages', 'protect_get_update_messages_about_devices', 'protect_upload_device_asset_file']));
    expect(OPERATIONS.filter((o) => o.response === 'image').map((o) => o.id)).toContain('protect_get_camera_snapshot');
  });
  it('puts an action that cannot be undone behind the delete tool', () => {
    expect(findOperation('protect_permanently_disable_camera_microphone')).toMatchObject({ method: 'POST', risk: 'delete' });
    expect(findOperation('protect_play_siren')!.risk).toBe('write');
  });
  it('searches one app at a time', () => {
    const found = search('camera', { app: 'protect' }, 100).operations;
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((o) => o.app === 'protect')).toBe(true);
    expect(search('camera', { app: 'network' }, 100).operations.every((o) => o.app === 'network')).toBe(true);
  });
});

describe('Protect calls', () => {
  const PROTECT = '/proxy/protect/integration/v1';
  const CAMERA = '665f9d8a01234567890abcde';

  it('reads without looking up a site, and trims fields', async () => {
    const { call, fake } = await connect({}, { [`GET ${PROTECT}/cameras`]: ok([{ id: CAMERA, name: 'Porch', mac: 'aa', extra: 1 }]) });
    expect(JSON.parse((await call('unifi_call', { operation: 'protect_get_all_cameras', fields: ['id', 'name'] })).text)).toEqual([{ id: CAMERA, name: 'Porch' }]);
    expect(fake.seen.map((s) => s.url)).toEqual([`${PROTECT}/cameras`]);
    expect(fake.seen[0]!.key).toBe('k');
  });
  it('returns a snapshot as an image, refusing one that is too big', async () => {
    const { client } = await connect({}, {
      [`GET ${PROTECT}/cameras/${CAMERA}/snapshot?highQuality=true`]: () => ({ status: 200, body: 'JPEGBYTES', contentType: 'image/jpeg' }),
      [`GET ${PROTECT}/cameras/${CAMERA}/snapshot`]: () => ({ status: 200, body: 'x'.repeat(MAX_IMAGE_BYTES + 1), contentType: 'image/jpeg' }),
    });
    const small = await client.callTool({ name: 'unifi_call', arguments: { operation: 'protect_get_camera_snapshot', path_params: { id: CAMERA }, query: { highQuality: true } } }) as { content: Array<{ type: string; data: string; mimeType: string }> };
    expect(small.content[0]).toEqual({ type: 'image', data: Buffer.from('JPEGBYTES').toString('base64'), mimeType: 'image/jpeg' });
    const big = await client.callTool({ name: 'unifi_call', arguments: { operation: 'protect_get_camera_snapshot', path_params: { id: CAMERA } } }) as { isError: boolean; content: Array<{ text: string }> };
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toContain('too big');
  });
  it('explains an operation it cannot run, in a call and in its description', async () => {
    const { call } = await connect();
    const r = await call('unifi_call', { operation: 'protect_get_protect_event_messages' });
    expect(r).toMatchObject({ error: true, text: expect.stringContaining('WebSocket') });
    expect(JSON.parse((await call('unifi_describe_operation', { operation: 'protect_get_protect_event_messages' })).text).notes.join(' ')).toContain('cannot run it');
    expect(JSON.parse((await call('unifi_describe_operation', { operation: 'protect_get_camera_snapshot' })).text).notes.join(' ')).toContain('returned as an image');
  });
  it('shows the current record before a PATCH that has a GET, and checks the body', async () => {
    const { call, fake } = await connect({}, { [`GET ${PROTECT}/cameras/${CAMERA}`]: ok({ id: CAMERA, name: 'Porch' }), [`PATCH ${PROTECT}/cameras/${CAMERA}`]: ok({ id: CAMERA, name: 'Front' }) });
    const dry = JSON.parse((await call('unifi_write', { operation: 'protect_patch_camera_settings', path_params: { id: CAMERA }, body: { name: 'Front' } })).text);
    expect(dry).toMatchObject({ dryRun: true, before: { name: 'Porch' }, request: { method: 'PATCH', body: { name: 'Front' } } });
    expect((await call('unifi_write', { operation: 'protect_patch_camera_settings', path_params: { id: CAMERA }, body: { name: 5 } })).text).toContain('body.name must be a string');
    expect(fake.seen.some((s) => s.method === 'PATCH')).toBe(false);
  });
  it('runs an action with no GET and no body (a siren), with no before', async () => {
    const { call, fake } = await connect({}, { [`POST ${PROTECT}/sirens/${CAMERA}/play`]: () => ({ status: 204 }) });
    const dry = JSON.parse((await call('unifi_write', { operation: 'protect_play_siren', path_params: { id: CAMERA } })).text);
    expect(dry.before).toBeUndefined();
    const applied = JSON.parse((await call('unifi_write', { operation: 'protect_play_siren', path_params: { id: CAMERA }, dry_run: false, confirm: true })).text);
    expect(applied).toMatchObject({ applied: true, answer: null });
    expect(fake.seen.some((s) => s.method === 'POST')).toBe(true);
  });
  it('dry-runs a delete that has no GET, and keeps the permanent action on the delete tool', async () => {
    const { call, fake } = await connect();
    const dry = JSON.parse((await call('unifi_delete', { operation: 'protect_delete_arm_profile', path_params: { id: CAMERA } })).text);
    expect(dry).toMatchObject({ dryRun: true, request: { method: 'DELETE' } });
    expect(dry.before).toBeUndefined();
    expect((await call('unifi_write', { operation: 'protect_permanently_disable_camera_microphone', path_params: { id: CAMERA } })).text).toContain('use unifi_delete');
    expect(fake.seen.some((s) => s.method === 'DELETE')).toBe(false);
  });
});

describe('trim', () => {
  it('keeps chosen keys of rows, wrapped rows or one record', () => {
    expect(trim({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(trim([{ a: 1, b: 2 }, 5], ['a'])).toEqual([{ a: 1 }, 5]);
    expect(trim({ data: [{ a: 1, b: 2 }], totalCount: 1 }, ['a'])).toEqual({ data: [{ a: 1 }], totalCount: 1 });
    expect(trim({ a: 1, b: 2 }, ['b'])).toEqual({ b: 2 });
  });
});

describe('redact', () => {
  it('replaces secret strings at any depth and leaves everything else', () => {
    expect(redact({ name: 'Home', x_passphrase: 'hunter2', nested: [{ wpa_psk: 'abc', n: 1 }], api_key: 5, password: { type: 'string' } }))
      .toEqual({ name: 'Home', x_passphrase: REDACTED, nested: [{ wpa_psk: REDACTED, n: 1 }], api_key: 5, password: { type: 'string' } });
    expect(redact(null)).toBeNull();
    expect(redact('x')).toBe('x');
  });
});

describe('secrets never reach the reply or the audit log', () => {
  const wlan = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Home', enabled: true, x_passphrase: 'hunter2-secret' };
  const route = { [`GET ${LEGACY}rest/wlanconf`]: ok({ data: [wlan] }), [`PUT ${LEGACY}rest/wlanconf/${wlan._id}`]: ok({ data: [{ ...wlan, enabled: false }] }), };
  const change = { operation: 'legacy_update_wlan', path_params: { id: wlan._id }, body: { enabled: false } };

  it('hides them in a read, a dry run and an applied change, but still sends them to the gateway', async () => {
    const lines: string[] = [];
    const { call, fake } = await connect({ audit: (l) => lines.push(l) }, route);
    expect((await call('unifi_call', { operation: 'legacy_list_wlan' })).text).not.toContain('hunter2');
    const dry = await call('unifi_write', change);
    expect(dry.text).not.toContain('hunter2');
    expect(dry.text).toContain(REDACTED);
    const applied = await call('unifi_write', { ...change, dry_run: false, confirm: true });
    expect(applied.text).not.toContain('hunter2');
    expect(lines.join()).not.toContain('hunter2');
    expect(JSON.parse(fake.seen.find((s) => s.method === 'PUT')!.body).x_passphrase).toBe('hunter2-secret');
  });
});

describe('unifi_search_api and unifi_describe_operation', () => {
  it('finds and describes an operation', async () => {
    const { call } = await connect();
    const found = JSON.parse((await call('unifi_search_api', { query: 'firewall zone', limit: 3 })).text);
    expect(found.operations.length).toBeGreaterThan(0);
    expect(found.tags).toContain('Legacy');
    const described = JSON.parse((await call('unifi_describe_operation', { operation: 'createFirewallZone' })).text);
    expect(described.body.required).toBe(true);
    expect(described.notes.join(' ')).toContain('siteId may be left out');
    const legacyDelete = JSON.parse((await call('unifi_describe_operation', { operation: 'legacy_delete_wlan' })).text);
    expect(legacyDelete.notes.join(' ')).toContain('unifi_delete');
    expect(JSON.parse((await call('unifi_describe_operation', { operation: 'legacy_update_wlan' })).text).notes.join(' ')).toContain('merged');
    expect(JSON.parse((await call('unifi_describe_operation', { operation: 'legacy_get_health' })).text).notes).toEqual(['Run it with unifi_call.']);
    expect(JSON.parse((await call('unifi_describe_operation', { operation: 'getFirewallZones' })).text).query.map((q: { name: string }) => q.name)).toContain('limit');
    expect(await call('unifi_describe_operation', { operation: 'nope' })).toMatchObject({ error: true });
  });
});

describe('unifi_call reads', () => {
  it('fills in the site, passes a query, trims fields', async () => {
    const { call, fake } = await connect({}, {
      'GET /proxy/network/integration/v1/sites': sites,
      [`GET ${OFFICIAL}/firewall/zones?limit=5`]: ok({ data: [{ id: ZONE, name: 'DMZ', extra: 1 }] }),
    });
    const r = await call('unifi_call', { operation: 'getFirewallZones', query: { limit: 5 }, fields: ['name'] });
    expect(JSON.parse(r.text)).toEqual({ data: [{ name: 'DMZ' }] });
    expect(fake.seen.map((s) => s.url)).toContain(`${OFFICIAL}/firewall/zones?limit=5`);
    expect(fake.seen.every((s) => s.key === 'k')).toBe(true);
  });
  it('runs a legacy read', async () => {
    const { call } = await connect();
    expect(JSON.parse((await call('unifi_call', { operation: 'legacy_get_health' })).text).data[0].subsystem).toBe('wan');
  });
  it('refuses bad input', async () => {
    const { call } = await connect({}, { 'GET /proxy/network/integration/v1/sites': sites });
    expect((await call('unifi_call', { operation: 'nope' })).error).toBe(true);
    expect((await call('unifi_call', { operation: 'getFirewallZones', body: {} })).text).toContain('takes no body');
    expect((await call('unifi_call', { operation: 'getFirewallZone' })).text).toContain('Missing path_params.firewallZoneId');
    expect((await call('unifi_call', { operation: 'getFirewallZone', path_params: { firewallZoneId: '../x' } })).text).toContain('not a valid UUID');
    const open = await connect({});
    expect((await open.call('unifi_delete', { operation: 'legacy_delete_wlan', path_params: { id: '../x' } })).text).toContain('not a valid id');
    expect((await call('unifi_call', { operation: 'getFirewallZones', query: { bogus: 1 } })).text).toContain('Unknown query parameter');
    expect((await call('unifi_call', { operation: 'legacy_get_health', query: { a: 1 } })).text).toContain('Declared: none');
  });
  it('needs required query parameters', async () => {
    const withRequired = OPERATIONS.find((o) => o.params.some((p) => p.in === 'query' && p.required));
    if (withRequired === undefined) return;   // this spec has no required query parameter
    const { call } = await connect({}, { 'GET /proxy/network/integration/v1/sites': sites });
    expect((await call('unifi_call', { operation: withRequired.id, path_params: Object.fromEntries(withRequired.params.filter((p) => p.in === 'path').map((p) => [p.name, ZONE])) })).text).toContain('Missing query parameter');
  });
  it('explains a site that cannot be found, and tries again later', async () => {
    let answer: unknown = { data: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] };
    const { call } = await connect({}, { 'GET /proxy/network/integration/v1/sites': () => ({ status: 200, body: JSON.stringify(answer) }), [`GET ${OFFICIAL}/firewall/zones`]: ok({ data: [] }) });
    expect((await call('unifi_call', { operation: 'getFirewallZones' })).text).toContain('Could not find the site');
    answer = {};
    expect((await call('unifi_call', { operation: 'getFirewallZones' })).text).toContain('Could not find the site');
    answer = { data: [{ id: SITE, name: 'Only' }] };
    expect((await call('unifi_call', { operation: 'getFirewallZones' })).error).toBe(false);
  });
  it('refuses a reply too big to return', async () => {
    const { call } = await connect({}, { [`GET ${LEGACY}stat/sta`]: ok({ data: ['x'.repeat(MAX_REPLY_CHARS)] }) });
    expect((await call('unifi_call', { operation: 'legacy_get_clients' })).text).toContain('too big');
  });
  it('turns a gateway failure into a tool error and rethrows anything else', async () => {
    const { call } = await connect({}, { [`GET ${LEGACY}stat/health`]: () => ({ status: 500 }), [`GET ${LEGACY}stat/sta`]: ok(5), [`GET ${LEGACY}stat/device`]: () => ({ status: 200, body: '{"data":' }) });
    expect((await call('unifi_call', { operation: 'legacy_get_health' })).text).toContain('500');
    expect((await call('unifi_call', { operation: 'legacy_get_clients', fields: ['a'] })).error).toBe(false);
  });
});

describe('unifi_write and unifi_delete', () => {
  const update = { operation: 'updateFirewallZone', path_params: { firewallZoneId: ZONE }, body: { name: 'New', networkIds: [] } };
  const zoneRoute = { 'GET /proxy/network/integration/v1/sites': sites, [`GET ${OFFICIAL}/firewall/zones/${ZONE}`]: ok({ id: ZONE, name: 'Old' }), [`PUT ${OFFICIAL}/firewall/zones/${ZONE}`]: ok({ id: ZONE, name: 'New' }) };

  it('refuses every change when the server is read-only', async () => {
    const { call, fake } = await connect({ readOnly: true }, zoneRoute);
    expect(await call('unifi_write', { ...update, dry_run: false, confirm: true })).toMatchObject({ error: true, text: expect.stringContaining('UNIFI_READ_ONLY=1') });
    expect((await call('unifi_delete', { operation: 'legacy_delete_wlan', path_params: { id: UUID_RULE_ID }, dry_run: false, confirm: true })).text).toContain('read-only');
    expect(fake.seen.some((s) => s.method === 'PUT' || s.method === 'DELETE')).toBe(false);
  });
  it('keeps reads, writes and deletes on their own tools', async () => {
    const { call } = await connect({}, zoneRoute);
    expect((await call('unifi_call', update)).text).toContain('use unifi_write');
    expect((await call('unifi_write', { operation: 'getFirewallZones' })).text).toContain('use unifi_call');
    expect((await call('unifi_write', { operation: 'deleteFirewallZone', path_params: { firewallZoneId: ZONE } })).text).toContain('use unifi_delete');
    expect((await call('unifi_delete', { operation: 'nope' })).error).toBe(true);
  });
  it('dry-runs by default, showing the current record', async () => {
    const { call, fake } = await connect({}, zoneRoute);
    const r = JSON.parse((await call('unifi_write', update)).text);
    expect(r).toMatchObject({ dryRun: true, before: { name: 'Old' }, request: { method: 'PUT', body: { name: 'New', networkIds: [] } } });
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('refuses a body that does not match the schema, sending nothing', async () => {
    const { call, fake } = await connect({}, zoneRoute);
    const r = await call('unifi_write', { ...update, body: { name: 'New', nmae: 'typo' }, dry_run: false, confirm: true });
    expect(r.error).toBe(true);
    expect(r.text).toContain('body.networkIds is required');
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('shows an unknown field as a warning without blocking the call', async () => {
    const { call, fake } = await connect({}, zoneRoute);
    const body = { name: 'New', networkIds: [], nmae: 'typo' };
    const dry = JSON.parse((await call('unifi_write', { ...update, body })).text);
    expect(dry.warnings).toEqual([expect.stringContaining('body.nmae is not a known field')]);
    const applied = JSON.parse((await call('unifi_write', { ...update, body, dry_run: false, confirm: true })).text);
    expect(applied.applied).toBe(true);
    expect(applied.warnings).toHaveLength(1);
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(true);
  });
  it('needs confirm=true to apply', async () => {
    const { call, fake } = await connect({}, zoneRoute);
    expect((await call('unifi_write', { ...update, dry_run: false })).text).toContain('confirm=true is required');
    expect(fake.seen.some((s) => s.method === 'PUT')).toBe(false);
  });
  it('applies, audits and returns the previous record', async () => {
    const lines: string[] = [];
    const { call, fake } = await connect({ audit: (l) => lines.push(l) }, zoneRoute);
    const r = JSON.parse((await call('unifi_write', { ...update, dry_run: false, confirm: true, fields: ['name'] })).text);
    expect(r).toMatchObject({ applied: true, before: { name: 'Old' }, answer: { name: 'New' } });
    expect(fake.seen.find((s) => s.method === 'PUT')!.body).toBe('{"name":"New","networkIds":[]}');
    expect(lines[0]).toContain('updateFirewallZone');
    expect(lines.join()).not.toContain('"k"');
  });
  it('needs a body for a create, and creates without a before', async () => {
    const lines: string[] = [];
    const { call, fake } = await connect({ audit: (l) => lines.push(l) }, { 'GET /proxy/network/integration/v1/sites': sites, [`POST ${OFFICIAL}/firewall/zones`]: ok({ id: ZONE }) });
    expect((await call('unifi_write', { operation: 'createFirewallZone' })).text).toContain('needs a body');
    const r = JSON.parse((await call('unifi_write', { operation: 'createFirewallZone', body: { name: 'X', networkIds: [] }, dry_run: false, confirm: true })).text);
    expect(r.applied).toBe(true);
    expect(r.before).toBeUndefined();
    expect(fake.seen.some((s) => s.method === 'POST')).toBe(true);
  });
  it('deletes only when both switches are on, logging no body', async () => {
    const lines: string[] = [];
    const { call, fake } = await connect({ audit: (l) => lines.push(l) }, { 'GET /proxy/network/integration/v1/sites': sites, [`GET ${OFFICIAL}/firewall/zones/${ZONE}`]: ok({ id: ZONE }), [`DELETE ${OFFICIAL}/firewall/zones/${ZONE}`]: () => ({ status: 200 }) });
    const r = JSON.parse((await call('unifi_delete', { operation: 'deleteFirewallZone', path_params: { firewallZoneId: ZONE }, dry_run: false, confirm: true })).text);
    expect(r.applied).toBe(true);
    expect(fake.seen.some((s) => s.method === 'DELETE')).toBe(true);
    expect(lines[0]).not.toContain('body');
  });
  it('merges a legacy update over the current row', async () => {
    const { call, fake } = await connect({});
    const r = JSON.parse((await call('unifi_write', { operation: 'legacy_update_port_forward', path_params: { id: UUID_RULE_ID }, body: { enabled: false }, dry_run: false, confirm: true })).text);
    expect(r.applied).toBe(true);
    expect(JSON.parse(fake.seen.find((s) => s.method === 'PUT')!.body)).toMatchObject({ _id: UUID_RULE_ID, enabled: false, fwd: '192.168.50.206' });
  });
  it('says so when a legacy record does not exist', async () => {
    const { call } = await connect({});
    expect((await call('unifi_write', { operation: 'legacy_update_port_forward', path_params: { id: 'missing' }, body: { enabled: false } })).text).toContain('No record has that id');
  });
  it('treats a list with no data as empty', async () => {
    const { call } = await connect({}, { [`GET ${LEGACY}rest/portforward`]: ok({}) });
    expect((await call('unifi_write', { operation: 'legacy_update_port_forward', path_params: { id: 'x' }, body: { enabled: true } })).text).toContain('No record');
  });
  it('rethrows what is not a gateway error', async () => {
    const { call } = await connect({}, { [`GET ${LEGACY}rest/portforward`]: ok({ data: 5 }) });
    expect((await call('unifi_write', { operation: 'legacy_update_port_forward', path_params: { id: 'x' }, body: { enabled: true } })).error).toBe(true);
  });
  it('runs a legacy command and creates with no before', async () => {
    const { call, fake } = await connect({}, { [`POST ${LEGACY}cmd/stamgr`]: ok({ meta: { rc: 'ok' } }) });
    const r = JSON.parse((await call('unifi_write', { operation: 'legacy_client_command', body: { cmd: 'kick-sta', mac: 'aa' }, dry_run: false, confirm: true })).text);
    expect(r.applied).toBe(true);
    expect(fake.seen.some((s) => s.method === 'POST')).toBe(true);
  });
});

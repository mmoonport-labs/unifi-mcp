import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findOperation, validateBody } from '../src/catalog.js';
import { validate } from '../src/validate.js';

const none = () => { throw new Error('no refs here'); };
const check = (schema: unknown, value: unknown) => validate(schema, value, none).errors;
const warn = (schema: unknown, value: unknown) => validate(schema, value, none).warnings;

describe('validate', () => {
  it('checks types', () => {
    expect(check({ type: 'string' }, 5)).toEqual(['body must be a string']);
    expect(check({ type: 'array' }, {})).toEqual(['body must be an array']);
    expect(check({ type: 'object' }, [])).toEqual(['body must be an object']);
    expect(check({ type: 'integer' }, 1.5)).toEqual(['body must be a integer']);
    expect(check({ type: 'number' }, 'x')).toEqual(['body must be a number']);
    expect(check({ type: 'boolean' }, true)).toEqual([]);
    expect(check({}, 'anything')).toEqual([]);
  });
  it('checks enums, lengths, uuids and ranges', () => {
    expect(check({ enum: ['A', 'B'] }, 'C')).toEqual(['body must be one of A, B']);
    expect(check({ type: 'string', minLength: 2, maxLength: 3 }, 'a')).toEqual(['body must be at least 2 characters']);
    expect(check({ type: 'string', maxLength: 3 }, 'abcd')).toEqual(['body must be at most 3 characters']);
    expect(check({ type: 'string', format: 'uuid' }, 'nope')).toEqual(['body must be a UUID']);
    expect(check({ type: 'string', format: 'uuid' }, '11111111-2222-3333-4444-555555555555')).toEqual([]);
    expect(check({ type: 'integer', minimum: 1, maximum: 5 }, 0)).toEqual(['body must be at least 1']);
    expect(check({ type: 'integer', maximum: 5 }, 9)).toEqual(['body must be at most 5']);
    expect(check({ type: 'integer', minimum: 1, maximum: 5 }, 3)).toEqual([]);
  });
  it('checks arrays and their items', () => {
    const schema = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } };
    expect(check(schema, [])).toEqual(['body needs at least 1 item(s)']);
    expect(check(schema, [1, 2, 3])).toEqual(['body allows at most 2 item(s)']);
    expect(check(schema, [1, 'x'])).toEqual(['body[1] must be a integer']);
    expect(check({ type: 'array' }, ['anything'])).toEqual([]);
  });
  it('checks objects: required, unknown fields, nulls, additionalProperties', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' }, size: { type: 'integer' } }, required: ['name'] };
    expect(check(schema, {})).toEqual(['body.name is required']);
    expect(check(schema, { name: 'x', nmae: 'y' })).toEqual([]);
    expect(warn(schema, { name: 'x', nmae: 'y' })).toEqual(['body.nmae is not a known field (known: name, size)']);
    expect(check(schema, { name: 'x', size: null })).toEqual([]);
    expect(check(schema, { name: null })).toEqual(['body.name must be a string']);
    expect(validate({ type: 'object', properties: { a: {} }, additionalProperties: true }, { a: 1, b: 2 }, none)).toEqual({ errors: [], warnings: [] });
    expect(check({ type: 'object', properties: { a: {} }, additionalProperties: { type: 'string' } }, { b: 2 })).toEqual(['body.b must be a string']);
    expect(validate({ type: 'object' }, { anything: 1 }, none)).toEqual({ errors: [], warnings: [] });
  });
  it('merges allOf, and follows a discriminator to the variant', () => {
    const base = { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], discriminator: { propertyName: 'type', mapping: { A: '#/A' } } };
    const variantA = { allOf: [base, { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }] };
    const resolve = (ref: string) => (ref === '#/A' ? variantA : undefined);
    expect(validate(base, { type: 'A', a: 1 }, resolve)).toEqual({ errors: [], warnings: [] });
    expect(validate(base, { type: 'A' }, resolve).errors).toEqual(['body.a is required']);
    expect(validate(base, { type: 'A', a: 1, z: 1 }, resolve).warnings).toEqual(['body.z is not a known field (known: a, type)']);
    expect(validate(base, { type: 'B' }, resolve).errors).toEqual(['body.type must be one of A']);
    expect(validate(base, {}, resolve).errors).toEqual(['body.type is required']);
    expect(validate(base, 'not an object', resolve).errors).toEqual(['body must be an object']);
  });
  it('matches a oneOf by the alternative that fits, or fits best', () => {
    const schema = { oneOf: [{ type: 'object', properties: { a: { type: 'integer' }, z: { type: 'integer' } }, required: ['a', 'z'] }, { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }] };
    expect(validate(schema, { b: 'x' }, none)).toEqual({ errors: [], warnings: [] });
    expect(validate(schema, { a: 1, z: 2, extra: true }, none).warnings).toEqual(['body.extra is not a known field (known: a, z)']);
    expect(validate(schema, { b: 5 }, none).errors).toEqual(['body.b must be a string']);
    expect(validate(schema, {}, none).errors).toEqual(['body.b is required']);
    expect(validate(schema, { a: 1 }, none).errors).toEqual(['body.z is required']);   // a tie keeps the first
  });
  it('reports at most ten errors and ten warnings', () => {
    expect(check({ type: 'array', items: { type: 'string' } }, Array.from({ length: 30 }, () => 1))).toHaveLength(10);
    expect(warn({ type: 'object', properties: { a: {} } }, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i)}`, 1])))).toHaveLength(10);
  });
});

describe('validateBody against the real spec', () => {
  const zone = '11111111-2222-3333-4444-555555555555';
  const policy = {
    enabled: true, name: 'Allow X', loggingEnabled: false, action: { type: 'ALLOW', allowReturnTraffic: true },
    source: { zoneId: zone }, destination: { zoneId: zone },
    ipProtocolScope: { ipVersion: 'IPV4' },
  };
  const op = () => findOperation('createFirewallPolicy')!;

  it('accepts a well-formed body', () => {
    expect(validateBody(op(), policy)).toEqual({ errors: [], warnings: [] });
  });
  it('rejects the old spec name for the zone, an unknown action and a missing field; only warns about an unknown one', () => {
    const old = validateBody(op(), { ...policy, source: { firewallZoneId: zone } });
    expect(old.errors).toContain('body.source.zoneId is required');
    expect(old.warnings.join(';')).toContain('body.source.firewallZoneId is not a known field');
    expect(validateBody(op(), { ...policy, action: { type: 'EXPLODE' } }).errors.join(';')).toContain('body.action.type must be one of');
    expect(validateBody(op(), { name: 'x' }).errors.join(';')).toContain('body.action is required');
    expect(validateBody(op(), { ...policy, reportFlowEnabled: true })).toEqual({ errors: [], warnings: [] });   // known since 11.0
    expect(validateBody(op(), { ...policy, notARealField: true })).toEqual({ errors: [], warnings: [expect.stringContaining('body.notARealField')] });
  });
  it('has nothing to say about an operation with no body', () => {
    expect(validateBody(findOperation('getFirewallZones')!, {})).toEqual({ errors: [], warnings: [] });
  });
  it('leaves the free-form legacy bodies alone', () => {
    expect(validateBody(findOperation('legacy_update_wlan')!, { anything: { goes: 1 } })).toEqual({ errors: [], warnings: [] });
  });
});

describe('validateBody for a Protect operation', () => {
  it('uses the Protect schemas', () => {
    const op = findOperation('protect_patch_camera_settings')!;
    expect(validateBody(op, { name: 'Porch' })).toEqual({ errors: [], warnings: [] });
    expect(validateBody(op, { name: 5 }).errors).toEqual(['body.name must be a string']);
  });
});

describe('UNIFI_SPEC_FILE', () => {
  const SPEC_DIR = process.env.UNIFI_SPEC_DIR;
  afterEach(() => { delete process.env.UNIFI_SPEC_FILE; delete process.env.UNIFI_PROTECT_SPEC_FILE; process.env.UNIFI_SPEC_DIR = SPEC_DIR; vi.resetModules(); });

  it('has only the legacy operations when no spec has been fetched', async () => {
    process.env.UNIFI_SPEC_DIR = mkdtempSync(join(tmpdir(), 'spec-'));
    vi.resetModules();
    const catalog = await import('../src/catalog.js');
    expect(catalog.SPEC_VERSIONS).toEqual({ network: 'none', protect: 'none' });
    expect(catalog.OPERATIONS.length).toBeGreaterThan(0);
    expect(catalog.OPERATIONS.every((o) => o.api === 'legacy')).toBe(true);
  });

  it('says a replaced Protect spec is custom, and the fetched one is versioned', async () => {
    expect((await import('../src/catalog.js')).SPEC_VERSIONS.protect).toMatch(/^\d+\.\d+\.\d+$/);
    const file = join(mkdtempSync(join(tmpdir(), 'spec-')), 'protect.json');
    writeFileSync(file, JSON.stringify({ components: { schemas: {} }, paths: {} }));
    process.env.UNIFI_PROTECT_SPEC_FILE = file;
    vi.resetModules();
    const catalog = await import('../src/catalog.js');
    expect(catalog.SPEC_VERSIONS.protect).toBe('custom');
    expect(catalog.OPERATIONS.some((o) => o.app === 'protect')).toBe(false);
  });

  it('replaces the fetched spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-'));
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify({ info: { version: '99.0.0' }, components: { schemas: {} }, paths: { '/v1/ping': { get: { operationId: 'ping', summary: 'Ping', tags: ['Misc'], responses: { '200': {} } } } } }));
    process.env.UNIFI_SPEC_FILE = file;
    vi.resetModules();
    const catalog = await import('../src/catalog.js');
    expect(catalog.SPEC_VERSIONS.network).toBe('custom');
    expect(catalog.findOperation('ping')).toMatchObject({ method: 'GET', path: '/proxy/network/integration/v1/ping' });
    expect(catalog.findOperation('getFirewallZones')).toBeUndefined();
  });
});

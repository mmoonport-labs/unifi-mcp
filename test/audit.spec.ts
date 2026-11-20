import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeAudit } from '../src/audit.js';

const at = () => new Date('2026-11-20T12:00:00Z');

describe('the audit log', () => {
  it('goes to stderr only when no file is named', () => {
    const err: string[] = [];
    makeAudit({}, (text) => err.push(text), at)('applied x');
    makeAudit({ UNIFI_AUDIT_LOG: '  ' }, (text) => err.push(text), at)('applied y');
    expect(err).toEqual(['unifi-mcp: applied x\n', 'unifi-mcp: applied y\n']);
  });

  it('appends one JSON line per change to the named file, private to the user', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
    const err: string[] = [];
    const audit = makeAudit({ UNIFI_AUDIT_LOG: file }, (text) => err.push(text), at);
    audit('applied a');
    audit('applied b "quoted"');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([{ time: '2026-11-20T12:00:00.000Z', event: 'applied a' }, { time: '2026-11-20T12:00:00.000Z', event: 'applied b "quoted"' }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(err).toHaveLength(2);
  });

  it('uses the real clock by default', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.jsonl');
    makeAudit({ UNIFI_AUDIT_LOG: file }, () => undefined)('applied');
    expect(new Date((JSON.parse(readFileSync(file, 'utf8')) as { time: string }).time).getFullYear()).toBeGreaterThan(2025);
  });

  it('reports a log it cannot write, and carries on', () => {
    const err: string[] = [];
    const audit = makeAudit({ UNIFI_AUDIT_LOG: join(tmpdir(), 'no-such-dir-xyz', 'audit.jsonl') }, (text) => err.push(text), at);
    expect(() => audit('applied z')).not.toThrow();
    expect(err[0]).toBe('unifi-mcp: applied z\n');
    expect(err[1]).toContain('could not write the audit log');
  });
});

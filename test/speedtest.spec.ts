import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { bar, line, scaleFor } from '../src/speedtest.js';
import { createServer, type ServerOptions } from '../src/tools.js';
import { Udm } from '../src/udm.js';
import { fakeUdm } from './fake-udm.js';

const DEV = '/proxy/network/api/s/default/cmd/devmgr';
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

const reading = (fields: Record<string, number>) => JSON.stringify({ meta: { rc: 'ok' }, data: [fields] });
const OLD = reading({ status_summary: 2, rundate: 100, xput_download: 808, xput_upload: 304, latency: 26, runtime: 28 });
const STARTED = JSON.stringify({ meta: { rc: 'ok' }, data: [] });

// The gateway's answers to POST cmd/devmgr in order (the last one repeats): first the status before the test, then the start, then the polls.
async function connect(script: string[], options: ServerOptions = {}) {
  let n = 0;
  const fake = await fakeUdm({ [`POST ${DEV}`]: () => ({ status: 200, body: script[Math.min(n++, script.length - 1)] }) });
  const server = createServer(new Udm({ baseUrl: fake.url, apiKey: 'k' }), { speedtest: { pollMs: 1, timeoutMs: 3000 }, ...options });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(fake.close, () => client.close());
  const run = async (args: Record<string, unknown>, onprogress?: (message: string) => void) => {
    const r = await client.callTool({ name: 'unifi_speedtest', arguments: args }, undefined, onprogress === undefined ? undefined : { onprogress: (p) => onprogress(String(p.message)) }) as { isError?: boolean; content: Array<{ text: string }> };
    return { error: r.isError === true, text: r.content[0]!.text };
  };
  return { fake, run, client };
}

describe('the bars', () => {
  it('fills in proportion and caps at the full length', () => {
    expect(bar(0, 2500)).toBe('[░░░░░░░░░░]');
    expect(bar(1250, 2500)).toBe('[█████░░░░░]');
    expect(bar(9000, 2500)).toBe('[██████████]');
  });
  it('widens the scale to the next round number only when a reading passes it', () => {
    expect(scaleFor(100, 2500)).toBe(2500);
    expect(scaleFor(3100, 2500)).toBe(5000);
    expect(scaleFor(250_000, 2500)).toBe(300_000);
  });
  it('shows both speeds and the latency on one line', () => {
    expect(line({ xput_download: 1250, xput_upload: 0, latency: 15 }, 2500)).toBe('↓ 1250 Mbps [█████░░░░░] 2500   ↑ 0 Mbps [░░░░░░░░░░] 2500   15 ms');
    expect(line({}, 100)).toBe('↓ 0 Mbps [░░░░░░░░░░] 100   ↑ 0 Mbps [░░░░░░░░░░] 100   0 ms');
  });
});

describe('unifi_speedtest', () => {
  it('is a dry run by default and starts nothing', async () => {
    const { run, fake } = await connect([OLD]);
    const dry = JSON.parse((await run({})).text);
    expect(dry).toMatchObject({ dryRun: true, request: { method: 'POST', body: { cmd: 'speedtest' } } });
    expect(dry.warning).toContain('whole WAN link');
    expect(fake.seen).toHaveLength(0);
  });

  it('needs confirm=true, and the server not to be read-only', async () => {
    const { run, fake } = await connect([OLD]);
    const refused = await run({ dry_run: false });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('confirm=true');
    expect(fake.seen).toHaveLength(0);
    const locked = await connect([OLD], { readOnly: true });
    expect((await locked.run({ dry_run: false, confirm: true })).text).toContain('read-only');
    expect(locked.fake.seen).toHaveLength(0);
  });

  it('runs the test, reports each reading as progress, and answers with the final result', async () => {
    const audit: string[] = [];
    const { run, fake } = await connect([
      OLD, STARTED,
      reading({ status_summary: 1, rundate: 200, xput_download: 600, xput_upload: 0, latency: 15 }),
      reading({ status_summary: 1, rundate: 200, xput_download: 2206, xput_upload: 900, latency: 15 }),
      reading({ status_summary: 2, rundate: 200, xput_download: 2206, xput_upload: 2321, latency: 15, runtime: 13 }),
    ], { audit: (l) => audit.push(l) });
    const messages: string[] = [];
    const r = await run({ dry_run: false, confirm: true }, (m) => messages.push(m));
    expect(JSON.parse(r.text)).toMatchObject({ applied: true, result: { download_mbps: 2206, upload_mbps: 2321, latency_ms: 15, test_seconds: 13 } });
    expect(messages).toEqual([
      '↓ 600 Mbps [██░░░░░░░░] 2500   ↑ 0 Mbps [░░░░░░░░░░] 2500   15 ms',
      '↓ 2206 Mbps [█████████░] 2500   ↑ 900 Mbps [████░░░░░░] 2500   15 ms',
      '↓ 2206 Mbps [█████████░] 2500   ↑ 2321 Mbps [█████████░] 2500   15 ms',
    ]);
    expect(fake.seen.map((s) => s.body)).toEqual(['status', 'start', 'p', 'p', 'p'].map((kind) => JSON.stringify({ cmd: kind === 'start' ? 'speedtest' : 'speedtest-status' })));
    expect(audit).toEqual([`applied speedtest POST ${DEV} body {"cmd":"speedtest"}`]);
  });

  it('works without progress and widens the scale for a faster link', async () => {
    const { run } = await connect([OLD, STARTED, reading({ status_summary: 2, rundate: 300, xput_download: 3100, xput_upload: 2900, latency: 4 })]);
    const r = JSON.parse((await run({ dry_run: false, confirm: true, scale_mbps: 1000 })).text);
    expect(r.display).toBe('↓ 3100 Mbps [██████░░░░] 5000   ↑ 2900 Mbps [██████░░░░] 5000   4 ms');
  });

  it('does not take the previous test\'s result for the new one', async () => {
    const { run } = await connect([OLD, STARTED, OLD, OLD, reading({ status_summary: 2, rundate: 200, xput_download: 1000, xput_upload: 500, latency: 9 })]);
    expect(JSON.parse((await run({ dry_run: false, confirm: true })).text).result.download_mbps).toBe(1000);
  });

  it('accepts a finished reading whose time is newer even if the running state was missed', async () => {
    const { run } = await connect([reading({ status_summary: 2 }), STARTED, reading({ status_summary: 2, timestamp: 5, xput_download: 10, xput_upload: 10 })]);
    expect(JSON.parse((await run({ dry_run: false, confirm: true })).text).result.download_mbps).toBe(10);
  });

  it('copes with a gateway that answers with nothing at first', async () => {
    const { run } = await connect([JSON.stringify({ data: [] }), STARTED, JSON.stringify({}), reading({ status_summary: 1, rundate: 1 }), reading({ status_summary: 2, rundate: 1, xput_download: 7, xput_upload: 8 })]);
    expect(JSON.parse((await run({ dry_run: false, confirm: true })).text).result).toMatchObject({ download_mbps: 7, upload_mbps: 8 });
  });

  it('gives up with the last reading when the test never finishes', async () => {
    const { run } = await connect([OLD, STARTED, reading({ status_summary: 1, rundate: 200, xput_download: 100, xput_upload: 0, latency: 1 })], { speedtest: { pollMs: 5, timeoutMs: 40 } });
    const r = await run({ dry_run: false, confirm: true });
    expect(r.error).toBe(true);
    expect(r.text).toContain('did not finish within');
    expect(r.text).toContain('↓ 100 Mbps');
    const silent = await connect([OLD, STARTED, OLD], { speedtest: { pollMs: 50, timeoutMs: 0 } });
    expect((await silent.run({ dry_run: false, confirm: true })).text).toContain('Last reading: none');
  });

  it('says so when the gateway refuses to start it', async () => {
    const fake = await fakeUdm({ [`POST ${DEV}`]: () => ({ status: 500 }) });
    const server = createServer(new Udm({ baseUrl: fake.url, apiKey: 'k' }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanup.push(fake.close, () => client.close());
    const r = await client.callTool({ name: 'unifi_speedtest', arguments: { dry_run: false, confirm: true } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('500');
  });

  it('reports an answer it cannot read as an error rather than hanging', async () => {
    const { run } = await connect(['null']);
    expect((await run({ dry_run: false, confirm: true })).error).toBe(true);
  });

  it('stops polling when the call is cancelled', async () => {
    const { client, fake } = await connect([OLD, STARTED, reading({ status_summary: 1, rundate: 200, xput_download: 1 })], { speedtest: { pollMs: 60, timeoutMs: 5000 } });
    const abort = new AbortController();
    const pending = client.callTool({ name: 'unifi_speedtest', arguments: { dry_run: false, confirm: true } }, undefined, { signal: abort.signal, onprogress: () => { setTimeout(() => abort.abort(), 5); } });
    await expect(pending).rejects.toThrow();
    const after = fake.seen.length;
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(fake.seen.length - after).toBeLessThanOrEqual(1);
  });
});

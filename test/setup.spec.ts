import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normaliseUrl, runSetup, type SetupDeps } from '../src/setup.js';
import { UdmError } from '../src/udm.js';
import { fakeUdm } from './fake-udm.js';

const FP = 'ab:'.repeat(31) + 'ab';
const KEY = 'sup3r-secret-key';

function deps(answers: string[], secret = KEY, extra: Partial<SetupDeps> = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const dir = join(mkdtempSync(join(tmpdir(), 'setup-')), 'cfg');
  const prompt = {
    ask: vi.fn(async (question: string, fallback?: string) => { asked.push(question); return answers.shift() || fallback || ''; }),
    askSecret: vi.fn(async () => secret),
  };
  const fingerprint = vi.fn(async () => FP);
  const verify = vi.fn(async () => '11.0.99');
  const all: SetupDeps = { prompt, out: (line) => out.push(line), store: { dir, platform: 'win32', run: async () => '' }, fingerprint, verify, ...extra };
  return { all, out, asked, dir, fingerprint, verify, prompt, text: () => out.join('\n') };
}

describe('normaliseUrl', () => {
  it('turns what people type into an origin', () => {
    expect(normaliseUrl('192.168.1.1')).toBe('https://192.168.1.1');
    expect(normaliseUrl('unifi.lan:8443')).toBe('https://unifi.lan:8443');
    expect(normaliseUrl('https://192.168.1.1/')).toBe('https://192.168.1.1');
    expect(normaliseUrl('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080');
  });
  it('refuses what cannot be one', () => {
    expect(normaliseUrl('')).toBeUndefined();
    expect(normaliseUrl('ftp://host')).toBeUndefined();
    expect(normaliseUrl('http://')).toBeUndefined();
    expect(normaliseUrl('a b')).toBeUndefined();
  });
});

describe('runSetup', () => {
  it('asks for the address and key, pins the approved certificate, checks the key, and saves', async () => {
    const d = deps(['192.168.1.1', 'y']);
    expect(await runSetup(d.all)).toBe(true);
    expect(d.fingerprint).toHaveBeenCalledWith('192.168.1.1', 443);
    expect(d.verify).toHaveBeenCalledWith({ baseUrl: 'https://192.168.1.1', apiKey: KEY, certSha256: FP });
    expect(JSON.parse(readFileSync(join(d.dir, 'config.json'), 'utf8'))).toEqual({ url: 'https://192.168.1.1', certSha256: FP });
    expect(d.text()).toContain(FP);
    expect(d.text()).toContain('Network 11.0.99');
    expect(d.text()).not.toContain(KEY);
  });

  it('offers the saved address as the default and uses an explicit port', async () => {
    const d = deps(['', 'yes'], KEY, { existing: { url: 'https://unifi.lan:8443' } });
    expect(await runSetup(d.all)).toBe(true);
    expect(d.fingerprint).toHaveBeenCalledWith('unifi.lan', 8443);
    expect(d.prompt.ask).toHaveBeenCalledWith('Gateway address (IP or URL)', 'https://unifi.lan:8443');
  });

  it('saves a plain http address without a certificate', async () => {
    const d = deps(['http://127.0.0.1:8080'], KEY, { verify: vi.fn(async () => undefined) });
    expect(await runSetup(d.all)).toBe(true);
    expect(d.fingerprint).not.toHaveBeenCalled();
    expect(d.text()).toContain('Connected to http://127.0.0.1:8080.');
  });

  it('saves nothing for an address it cannot use', async () => {
    const d = deps(['ftp://x']);
    expect(await runSetup(d.all)).toBe(false);
    expect(d.text()).toContain('Nothing was saved');
    expect(d.prompt.askSecret).not.toHaveBeenCalled();
  });

  it('saves nothing when the gateway cannot be reached', async () => {
    const d = deps(['10.0.0.1'], KEY, { fingerprint: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await runSetup(d.all)).toBe(false);
    expect(d.text()).toContain('Could not reach https://10.0.0.1 (ECONNREFUSED)');
  });

  it('saves nothing when the certificate is not trusted, and does not ask for the key', async () => {
    const d = deps(['10.0.0.1', '']);
    expect(await runSetup(d.all)).toBe(false);
    expect(d.text()).toContain('Not trusted');
    expect(d.prompt.askSecret).not.toHaveBeenCalled();
  });

  it('saves nothing without a key', async () => {
    const d = deps(['10.0.0.1', 'y'], '');
    expect(await runSetup(d.all)).toBe(false);
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('saves nothing when the gateway refuses the key, and never prints it', async () => {
    const d = deps(['10.0.0.1', 'y'], KEY, { verify: vi.fn(async () => { throw new UdmError('The gateway answered 401 to GET /x.', 401); }) });
    expect(await runSetup(d.all)).toBe(false);
    expect(d.text()).toContain('The gateway did not accept that: The gateway answered 401');
    expect(d.text()).not.toContain(KEY);
    const plain = deps(['10.0.0.1', 'y'], KEY, { verify: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await runSetup(plain.all)).toBe(false);
    expect(plain.text()).toContain('boom');
  });
});

describe('the real check of the key', () => {
  it('asks the gateway for its Network version', async () => {
    const fake = await fakeUdm({ 'GET /proxy/network/integration/v1/info': () => ({ status: 200, body: JSON.stringify({ applicationVersion: '11.0.99' }) }) });
    try {
      const d = deps([fake.url], KEY, { verify: undefined });
      expect(await runSetup({ ...d.all, verify: undefined })).toBe(true);
      expect(d.text()).toContain('Network 11.0.99');
    } finally {
      await fake.close();
    }
  });
});

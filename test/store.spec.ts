import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearStored, configDir, readStored, saveStored, type Run, type StoreOptions } from '../src/store.js';

const FP = 'ab:'.repeat(31) + 'ab';
const tmp = () => join(mkdtempSync(join(tmpdir(), 'store-')), 'cfg');
// A secret store that remembers what it is given, keyed by the command's first argument.
function fakeSecrets(fail = false) {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  let secret: string | undefined;
  const run: Run = async (command, args, input) => {
    calls.push({ command, args, input });
    if (fail) throw new Error('no such tool');
    if (args[0] === '-i') secret = /-w (\S+)/.exec(input ?? '')?.[1];
    else if (args[0] === 'store') secret = input;
    else if (/^(?:find-generic-password|lookup)$/.test(args[0]!)) { if (secret === undefined) throw new Error('not found'); return `${secret}\n`; }
    else secret = undefined;
    return '';
  };
  return { run, calls, get secret() { return secret; } };
}

describe('where the config lives', () => {
  it('uses UNIFI_CONFIG_DIR, then the XDG config home, then ~/.config', () => {
    expect(configDir({ UNIFI_CONFIG_DIR: '/c' })).toBe('/c');
    expect(configDir({ XDG_CONFIG_HOME: '/x' })).toBe(join('/x', 'unifi-mcp'));
    expect(configDir({})).toMatch(/\.config[\\/]unifi-mcp$/);
  });
});

describe('the macOS Keychain', () => {
  it('takes the key on stdin, not on a command line, and keeps it out of the files', async () => {
    const secrets = fakeSecrets();
    const options: StoreOptions = { dir: tmp(), platform: 'darwin', run: secrets.run };
    expect(await saveStored(options, { url: 'https://192.168.1.1', certSha256: FP, apiKey: 'abc-123_XYZ' })).toBe('the macOS Keychain');
    expect(secrets.calls[0]).toMatchObject({ command: 'security', args: ['-i'] });
    expect(secrets.calls[0]!.args.join(' ')).not.toContain('abc-123');
    expect(readFileSync(join(options.dir, 'config.json'), 'utf8')).not.toContain('abc-123');
    expect(existsSync(join(options.dir, 'key'))).toBe(false);
    expect(await readStored(options)).toEqual({ url: 'https://192.168.1.1', certSha256: FP, apiKey: 'abc-123_XYZ' });
  });

  it('leaves no key file behind when the key moves to the Keychain', async () => {
    const dir = tmp();
    await saveStored({ dir, platform: 'win32', run: fakeSecrets().run }, { url: 'https://g', apiKey: 'k1' });
    expect(existsSync(join(dir, 'key'))).toBe(true);
    await saveStored({ dir, platform: 'darwin', run: fakeSecrets().run }, { url: 'https://g', apiKey: 'k2' });
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('reads and forgets', async () => {
    const secrets = fakeSecrets();
    const options: StoreOptions = { dir: tmp(), platform: 'darwin', run: secrets.run };
    await saveStored(options, { url: 'https://g', apiKey: 'k' });
    await clearStored(options);
    expect(secrets.secret).toBeUndefined();
    expect(existsSync(join(options.dir, 'config.json'))).toBe(false);
    expect(await readStored(options)).toBeUndefined();
  });
});

describe('libsecret', () => {
  it('gives the key to secret-tool on stdin', async () => {
    const secrets = fakeSecrets();
    const options: StoreOptions = { dir: tmp(), platform: 'linux', run: secrets.run };
    expect(await saveStored(options, { url: 'https://g', apiKey: 'k' })).toBe('the system keyring');
    expect(secrets.calls[0]).toMatchObject({ command: 'secret-tool', input: 'k' });
    expect(await readStored(options)).toMatchObject({ apiKey: 'k' });
    await clearStored(options);
    expect(secrets.secret).toBeUndefined();
  });
});

describe('the private file', () => {
  it('is used when there is no secret store, and only the user can read it', async () => {
    const options: StoreOptions = { dir: tmp(), platform: 'win32', run: fakeSecrets().run };
    expect(await saveStored(options, { url: 'https://g', apiKey: 'k' })).toBe(join(options.dir, 'key'));
    expect(statSync(join(options.dir, 'key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(options.dir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(await readStored(options)).toEqual({ url: 'https://g', certSha256: undefined, apiKey: 'k' });
    await clearStored(options);
    expect(existsSync(join(options.dir, 'key'))).toBe(false);
  });

  it('is used when the secret store fails, or the key has characters the Keychain command cannot take safely', async () => {
    const broken: StoreOptions = { dir: tmp(), platform: 'darwin', run: fakeSecrets(true).run };
    expect(await saveStored(broken, { url: 'https://g', apiKey: 'k' })).toBe(join(broken.dir, 'key'));
    expect(await readStored(broken)).toMatchObject({ apiKey: 'k' });
    const secrets = fakeSecrets();
    const odd: StoreOptions = { dir: tmp(), platform: 'darwin', run: secrets.run };
    expect(await saveStored(odd, { url: 'https://g', apiKey: 'a b"c' })).toBe(join(odd.dir, 'key'));
    expect(secrets.calls).toEqual([]);
  });

  it('reads nothing from a missing or damaged config, or one with no address', async () => {
    const options: StoreOptions = { dir: tmp(), platform: 'win32', run: fakeSecrets().run };
    expect(await readStored(options)).toBeUndefined();
    await saveStored(options, { url: 'https://g', apiKey: 'k' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(options.dir, 'config.json'), '{"certSha256":5}');
    expect(await readStored(options)).toBeUndefined();
    writeFileSync(join(options.dir, 'config.json'), '{"url":"https://g","certSha256":5}');
    expect(await readStored(options)).toEqual({ url: 'https://g', certSha256: undefined, apiKey: 'k' });
    writeFileSync(join(options.dir, 'key'), '\n');
    expect(await readStored(options)).toMatchObject({ apiKey: undefined });
  });

  it('has an address but no key when the key is gone', async () => {
    const options: StoreOptions = { dir: tmp(), platform: 'darwin', run: fakeSecrets().run };
    await saveStored(options, { url: 'https://g', apiKey: 'k' });
    const { rmSync } = await import('node:fs');
    options.run = fakeSecrets().run;  // an empty Keychain
    rmSync(join(options.dir, 'key'), { force: true });
    expect(await readStored(options)).toEqual({ url: 'https://g', certSha256: undefined, apiKey: undefined });
  });
});

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// What `unifi-mcp setup` saves: the gateway address and the pinned certificate in config.json, and the API key in the system's secret
// store when there is one (the macOS Keychain, or libsecret on Linux), else in a file only the user can read. The key is never in
// config.json, and environment variables, when set, win over all of this.
export interface Stored {
  url: string;
  certSha256?: string;
  apiKey?: string;
}

// Runs a command (optionally giving it text on stdin) and resolves with its stdout; rejects when it fails or is not there.
export type Run = (command: string, args: string[], input?: string) => Promise<string>;

export interface StoreOptions {
  dir: string;
  platform: NodeJS.Platform;
  run: Run;
}

export const configDir = (env: NodeJS.ProcessEnv): string => env.UNIFI_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'unifi-mcp');

const SERVICE = 'unifi-mcp';
const ACCOUNT = 'gateway';
// `security -i` takes its commands on stdin, so the key is never on a command line (where `ps` would show it). It is quoted for that
// parser, so only keys made of safe characters go to the Keychain; anything else goes to the file.
const SAFE_KEY = /^[A-Za-z0-9_.~+/=-]+$/;

const keychain = (options: StoreOptions) => {
  if (options.platform === 'darwin') {
    return {
      store: (key: string) => options.run('security', ['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -w ${key}\n`),
      load: () => options.run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']),
      remove: () => options.run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]),
    };
  }
  if (options.platform === 'linux') {
    return {
      store: (key: string) => options.run('secret-tool', ['store', '--label=unifi-mcp API key', 'service', SERVICE, 'account', ACCOUNT], key),
      load: () => options.run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]),
      remove: () => options.run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]),
    };
  }
  return undefined;
};

const keyFile = (options: StoreOptions) => join(options.dir, 'key');
const configFile = (options: StoreOptions) => join(options.dir, 'config.json');

function writePrivate(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// Returns where the key went, for the user to read.
export async function saveStored(options: StoreOptions, stored: Stored & { apiKey: string }): Promise<string> {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  writePrivate(configFile(options), `${JSON.stringify({ url: stored.url, certSha256: stored.certSha256 }, null, 2)}\n`);
  const secrets = keychain(options);
  if (secrets !== undefined && SAFE_KEY.test(stored.apiKey)) {
    try {
      await secrets.store(stored.apiKey);
      rmSync(keyFile(options), { force: true });
      return options.platform === 'darwin' ? 'the macOS Keychain' : 'the system keyring';
    } catch { /* no keychain tool or it refused: use the file */ }
  }
  writePrivate(keyFile(options), `${stored.apiKey}\n`);
  return keyFile(options);
}

export async function readStored(options: StoreOptions): Promise<Stored | undefined> {
  let config: { url?: unknown; certSha256?: unknown };
  try {
    config = JSON.parse(readFileSync(configFile(options), 'utf8')) as typeof config;
  } catch {
    return undefined;
  }
  if (typeof config.url !== 'string') return undefined;
  let apiKey: string | undefined;
  try {
    apiKey = (await keychain(options)?.load())?.trim();
  } catch { /* not in the keychain */ }
  if (!apiKey && existsSync(keyFile(options))) apiKey = readFileSync(keyFile(options), 'utf8').trim();
  return { url: config.url, certSha256: typeof config.certSha256 === 'string' ? config.certSha256 : undefined, apiKey: apiKey || undefined };
}

export async function clearStored(options: StoreOptions): Promise<void> {
  try {
    await keychain(options)?.remove();
  } catch { /* nothing there */ }
  rmSync(configFile(options), { force: true });
  rmSync(keyFile(options), { force: true });
}

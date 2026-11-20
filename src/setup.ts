import { connect } from 'node:tls';
import { UdmError, Udm, type UdmOptions } from './udm.js';
import { saveStored, type StoreOptions, type Stored } from './store.js';
import type { Prompter } from './prompt.js';

// The gateway's certificate fingerprint, read without trusting it (it is self-signed): the user is shown it and decides.
export function peerFingerprint(host: string, port: number, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, servername: /^[\d.:]+$/.test(host) ? undefined : host, timeout });
    socket.once('secureConnect', () => {
      const { fingerprint256 } = socket.getPeerCertificate();
      socket.destroy();
      resolve(fingerprint256);
    });
    socket.once('timeout', () => socket.destroy(new Error('timed out')));
    socket.once('error', reject);
  });
}

// "192.168.1.1", "unifi.lan:8443" and "https://192.168.1.1/" all become an origin; undefined when it cannot be one.
export function normaliseUrl(text: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export interface SetupDeps {
  prompt: Pick<Prompter, 'ask' | 'askSecret'>;
  out: (line: string) => void;
  store: StoreOptions;
  existing?: Stored;
  fingerprint?: typeof peerFingerprint;
  // The gateway's Network version, or a thrown error: proves the address, the pinned certificate and the key all work.
  verify?: (options: UdmOptions) => Promise<string | undefined>;
}

const verifyGateway = async (options: UdmOptions) => (await new Udm(options).get<{ applicationVersion?: string }>('/proxy/network/integration/v1/info')).applicationVersion;

// Asks for the gateway's address and API key, pins the certificate the user approves, checks that the key works, then saves. Nothing is
// saved unless every step passed. Returns whether it saved.
export async function runSetup({ prompt, out, store, existing, fingerprint = peerFingerprint, verify = verifyGateway }: SetupDeps): Promise<boolean> {
  out('Set up unifi-mcp: the address of your UniFi gateway and an API key.');
  out('Create the key in UniFi: Settings > Control Plane > Integrations.\n');
  const baseUrl = normaliseUrl(await prompt.ask('Gateway address (IP or URL)', existing?.url));
  if (baseUrl === undefined) {
    out('That is not an address I can use. Nothing was saved.');
    return false;
  }
  let certSha256: string | undefined;
  const { hostname, port, protocol } = new URL(baseUrl);
  if (protocol === 'https:') {
    try {
      certSha256 = await fingerprint(hostname, Number(port || 443));
    } catch (error) {
      out(`Could not reach ${baseUrl} (${(error as Error).message}). Nothing was saved.`);
      return false;
    }
    out(`\nThe gateway presented a certificate with this SHA-256 fingerprint:\n  ${certSha256}`);
    out('A UniFi gateway signs its own certificate, so check it against the one in your UniFi settings or browser if you can.');
    if (!/^y(es)?$/i.test(await prompt.ask('Trust this certificate and only ever send the key to it? (y/N)'))) {
      out('Not trusted. Nothing was saved.');
      return false;
    }
  }
  const apiKey = await prompt.askSecret('API key (typing is hidden)');
  if (apiKey === '') {
    out('No key entered. Nothing was saved.');
    return false;
  }
  let version: string | undefined;
  try {
    version = await verify({ baseUrl, apiKey, certSha256 });
  } catch (error) {
    out(`The gateway did not accept that: ${error instanceof UdmError ? error.message : (error as Error).message}. Nothing was saved.`);
    return false;
  }
  const where = await saveStored(store, { url: baseUrl, certSha256, apiKey });
  out(`\nConnected to ${baseUrl}${version === undefined ? '' : ` (Network ${version})`}. Saved the address and fingerprint to ${store.dir}, and the key to ${where}.`);
  out('Add it to your MCP client with: npx -y @mmoonport-labs/unifi-mcp   (no environment variables needed).');
  return true;
}

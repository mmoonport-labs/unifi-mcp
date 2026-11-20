import type { Stored } from './store.js';
import type { ServerOptions } from './tools.js';
import type { UdmOptions } from './udm.js';

export class ConfigError extends Error {}

// The environment wins; what `unifi-mcp setup` saved fills in whatever the environment leaves out. The key is read here and goes nowhere
// but the X-API-KEY header.
export function loadConfig(env: NodeJS.ProcessEnv, stored?: Stored): { udm: UdmOptions; server: ServerOptions } {
  const baseUrl = env.UNIFI_URL?.trim() || stored?.url;
  // The saved key and certificate belong to the saved address: never send them to another one the environment names.
  const saved = baseUrl === stored?.url ? stored : undefined;
  const apiKey = env.UNIFI_API_KEY?.trim() || saved?.apiKey;
  if (!baseUrl) throw new ConfigError('No gateway is set up. Run "unifi-mcp setup" (npx -y @mmoonport-labs/unifi-mcp setup), or set UNIFI_URL (for example https://192.168.1.1) and UNIFI_API_KEY.');
  if (!apiKey) throw new ConfigError('UNIFI_API_KEY is required (or run "unifi-mcp setup" to store a key).');
  try {
    new URL(baseUrl);
  } catch {
    throw new ConfigError('UNIFI_URL is not a URL.');
  }
  const certSha256 = env.UNIFI_CERT_SHA256?.trim() || saved?.certSha256;
  if (certSha256 !== undefined && !/^([0-9a-f]{2}:?){32}$/i.test(certSha256)) throw new ConfigError('UNIFI_CERT_SHA256 must be a SHA-256 fingerprint (64 hex digits, colons optional).');
  return {
    udm: { baseUrl, apiKey, site: env.UNIFI_SITE?.trim() || 'default', insecure: env.UNIFI_INSECURE === '1', certSha256 },
    server: { readOnly: env.UNIFI_READ_ONLY === '1' },
  };
}

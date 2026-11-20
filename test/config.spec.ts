import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const OK = { UNIFI_URL: 'https://192.168.1.1', UNIFI_API_KEY: 'k' };

describe('loadConfig', () => {
  it('reads the environment; writes are not blocked by default', () => {
    expect(loadConfig(OK)).toEqual({ udm: { baseUrl: 'https://192.168.1.1', apiKey: 'k', site: 'default', insecure: false, certSha256: undefined }, server: { readOnly: false } });
  });
  it('reads the options', () => {
    const fp = 'ab:'.repeat(31) + 'ab';
    const c = loadConfig({ ...OK, UNIFI_SITE: 's', UNIFI_INSECURE: '1', UNIFI_READ_ONLY: '1', UNIFI_CERT_SHA256: fp });
    expect(c.udm).toMatchObject({ site: 's', insecure: true, certSha256: fp });
    expect(c.server.readOnly).toBe(true);
  });
  it('fills what the environment leaves out from what setup saved, but only for the saved address', () => {
    const fp = 'ab:'.repeat(31) + 'ab';
    const stored = { url: 'https://192.168.1.1', apiKey: 'saved', certSha256: fp };
    expect(loadConfig({}, stored).udm).toMatchObject({ baseUrl: 'https://192.168.1.1', apiKey: 'saved', certSha256: fp });
    expect(loadConfig({ UNIFI_API_KEY: 'env' }, stored).udm).toMatchObject({ apiKey: 'env', certSha256: fp });
    // another address from the environment never gets the saved key or the pinned certificate
    expect(() => loadConfig({ UNIFI_URL: 'https://10.0.0.1' }, stored)).toThrow('UNIFI_API_KEY');
    expect(loadConfig({ UNIFI_URL: 'https://10.0.0.1', UNIFI_API_KEY: 'env' }, stored).udm).toMatchObject({ apiKey: 'env', certSha256: undefined });
  });
  it('points to setup when nothing is configured', () => {
    expect(() => loadConfig({})).toThrow('unifi-mcp setup');
  });
  it('refuses what is missing or malformed, without echoing the key', () => {
    expect(() => loadConfig({ UNIFI_API_KEY: 'k' })).toThrow(ConfigError);
    expect(() => loadConfig({ UNIFI_URL: 'https://x' })).toThrow('UNIFI_API_KEY');
    expect(() => loadConfig({ ...OK, UNIFI_URL: 'nonsense' })).toThrow('not a URL');
    expect(() => loadConfig({ ...OK, UNIFI_CERT_SHA256: 'zz' })).toThrow('SHA-256');
  });
});

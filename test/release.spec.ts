import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as Record<string, any>;

describe('release metadata', () => {
  const pkg = json('package.json');
  const registry = json('server.json');

  it('keeps the versions of the package and the registry entry together', () => {
    expect(registry.version).toBe(pkg.version);
    expect(registry.packages[0].version).toBe(pkg.version);
    expect(registry.packages[0].identifier).toBe(pkg.name);
  });

  it('keeps the Claude Code plugin at the package version and pointing at the package', () => {
    const plugin = json('.claude-plugin/plugin.json');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.mcpServers.unifi.args).toEqual(['-y', pkg.name]);
    const market = json('.claude-plugin/marketplace.json');
    expect(market.plugins.map((entry: { name: string }) => entry.name)).toContain(plugin.name);
  });

  it('names the server the same in the package and the registry (the registry checks this)', () => {
    expect(pkg.mcpName).toBe(registry.name);
    expect(registry.name).toMatch(/^io\.github\.mmoonport-labs\//);
  });

  it('keeps the registry description within its 100-character limit', () => {
    expect(registry.description.length).toBeLessThanOrEqual(100);
  });

  it('serves the same version it is published under', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createServer } = await import('../src/tools.js');
    const { Udm } = await import('../src/udm.js');
    const server = createServer(new Udm({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getServerVersion()).toMatchObject({ name: 'unifi-mcp', version: pkg.version });
    await client.close();
  });
});

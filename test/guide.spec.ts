import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { guide, GUIDE_URI, INSTRUCTIONS } from '../src/guide.js';
import { createServer } from '../src/tools.js';
import { Udm } from '../src/udm.js';
import { fakeUdm } from './fake-udm.js';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

async function connect() {
  const fake = await fakeUdm();
  const server = createServer(new Udm({ baseUrl: fake.url, apiKey: 'k' }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(fake.close, () => client.close());
  return client;
}

describe('guidance for any client', () => {
  it('sends the instructions at initialize', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain(GUIDE_URI);
  });

  it('serves the guide as a resource and as a prompt', async () => {
    const client = await connect();
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([GUIDE_URI]);
    const read = await client.readResource({ uri: GUIDE_URI });
    expect((read.contents[0] as { text: string }).text).toBe(guide());
    const prompt = await client.getPrompt({ name: 'unifi_guide' });
    expect((prompt.messages[0]!.content as { text: string }).text).toBe(guide());
  });

  it('keeps the guide free of client-specific text and of local details', () => {
    const text = guide();
    expect(text).toContain('search, describe, call');
    expect(text).not.toMatch(/Claude|\/mcp|Bash/);
    expect(text).not.toMatch(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i);
  });
});

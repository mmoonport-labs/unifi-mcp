#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { prepareSpecs } from './specs.js';
import { Udm } from './udm.js';

try {
  const config = loadConfig(process.env);
  const udm = new Udm(config.udm);
  const log = (line: string) => process.stderr.write(`unifi-mcp: ${line}\n`);
  // The spec for the gateway's version is fetched before the catalog (which reads it when first imported) is loaded.
  await prepareSpecs(udm, process.env, log);
  const { createServer } = await import('./tools.js');
  const server = createServer(udm, { ...config.server, audit: (line) => process.stderr.write(`unifi-mcp: ${line}\n`) });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`unifi-mcp: ready, ${config.server.readOnly ? 'READ-ONLY' : 'writes gated by the client permissions'}\n`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`unifi-mcp: ${error.message}\n`);
  process.exit(1);
}

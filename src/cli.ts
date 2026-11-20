import { execFile } from 'node:child_process';
import type { Run, StoreOptions } from './store.js';
import { clearStored, configDir } from './store.js';
import { createPrompter } from './prompt.js';
import { readStored } from './store.js';
import { runSetup } from './setup.js';
import type { Readable, Writable } from 'node:stream';

export const run: Run = (command, args, input) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  child.stdin?.end(input);
});

export const storeOptions = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, runner: Run = run): StoreOptions => ({ dir: configDir(env), platform, run: runner });

export const USAGE = `unifi-mcp: an MCP server for a UniFi gateway.

  unifi-mcp           start the server (stdio); used by an MCP client
  unifi-mcp setup     ask for the gateway address and API key, and save them
  unifi-mcp logout    forget the saved address and key
`;

export interface Cli {
  env: NodeJS.ProcessEnv;
  input: Readable;
  output: Writable;
  store?: StoreOptions;
  setup?: typeof runSetup;
}

// The commands other than starting the server. Returns the exit code, or undefined when the arguments name no command.
export async function runCommand(args: string[], cli: Cli): Promise<number | undefined> {
  const out = (line: string) => { cli.output.write(`${line}\n`); };
  const store = cli.store ?? storeOptions(cli.env);
  if (args[0] === 'setup') {
    const prompt = createPrompter(cli.input, cli.output);
    try {
      return (await (cli.setup ?? runSetup)({ prompt, out, store, existing: await readStored(store) })) ? 0 : 1;
    } finally {
      prompt.close();
    }
  }
  if (args[0] === 'logout') {
    await clearStored(store);
    out('Forgot the saved address and key.');
    return 0;
  }
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    out(USAGE.trimEnd());
    return 0;
  }
  return undefined;
}

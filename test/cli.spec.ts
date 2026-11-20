import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { run, runCommand, storeOptions, USAGE } from '../src/cli.js';
import { saveStored } from '../src/store.js';

const cli = () => {
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const dir = join(mkdtempSync(join(tmpdir(), 'cli-')), 'cfg');
  return { env: { UNIFI_CONFIG_DIR: dir }, input: new PassThrough(), output, store: { dir, platform: 'win32' as const, run: async () => '' }, shown: () => shown };
};

describe('commands', () => {
  it('names no command for no arguments, or arguments it does not know', async () => {
    expect(await runCommand([], cli())).toBeUndefined();
    expect(await runCommand(['serve'], cli())).toBeUndefined();
  });

  it('prints usage', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const c = cli();
      expect(await runCommand([flag], c)).toBe(0);
      expect(c.shown()).toContain(USAGE.split('\n')[0]);
    }
  });

  it('runs setup with what was saved before, and returns 0 or 1', async () => {
    const c = cli();
    await saveStored(c.store, { url: 'https://192.168.1.1', apiKey: 'k' });
    const setup = vi.fn(async () => true);
    expect(await runCommand(['setup'], { ...c, setup })).toBe(0);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ existing: expect.objectContaining({ url: 'https://192.168.1.1' }) }));
    expect(await runCommand(['setup'], { ...c, setup: async () => false })).toBe(1);
  });

  it('uses the real setup and the config directory from the environment by default', async () => {
    const c = cli();
    c.input.end();
    expect(await runCommand(['setup'], { env: c.env, input: c.input, output: c.output })).toBe(1);
    expect(c.shown()).toContain('Nothing was saved');
    expect(await runCommand(['logout'], { env: c.env, input: c.input, output: c.output })).toBe(0);
  });

  it('forgets what was saved', async () => {
    const c = cli();
    await saveStored(c.store, { url: 'https://g', apiKey: 'k' });
    expect(await runCommand(['logout'], c)).toBe(0);
    expect(existsSync(join(c.store.dir, 'config.json'))).toBe(false);
    expect(c.shown()).toContain('Forgot');
  });
});

describe('the real command runner', () => {
  it('gives stdin to the command and returns its output, and rejects when it fails', async () => {
    expect(await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello')).toBe('hello');
    await expect(run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
    await expect(run('definitely-not-a-command-xyz', [])).rejects.toThrow();
  });

  it('builds store options from the environment', () => {
    expect(storeOptions({ UNIFI_CONFIG_DIR: '/c' }, 'linux')).toMatchObject({ dir: '/c', platform: 'linux', run });
    expect(storeOptions({ UNIFI_CONFIG_DIR: '/c' }).platform).toBe(process.platform);
  });
});

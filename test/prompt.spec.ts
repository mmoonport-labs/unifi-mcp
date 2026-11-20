import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter } from '../src/prompt.js';

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  return { input, prompter: createPrompter(input, output), shown: () => shown };
}

describe('the prompter', () => {
  it('asks, trims, and offers a default for an empty answer', async () => {
    const { input, prompter, shown } = setup();
    input.write('  192.168.1.1  \n\n');
    expect(await prompter.ask('Address')).toBe('192.168.1.1');
    expect(await prompter.ask('Again', 'dflt')).toBe('dflt');
    expect(shown()).toBe('Address: Again [dflt]: ');
    prompter.close();
  });

  it('answers empty when the input ends', async () => {
    const { input, prompter } = setup();
    input.end();
    expect(await prompter.ask('Q')).toBe('');
    prompter.close();
  });

  it('never echoes a secret, then echoes again', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
    const prompter = createPrompter(input, output);
    const pending = prompter.askSecret('Key');
    input.write('s3cret-value\n');
    expect(await pending).toBe('s3cret-value');
    expect(shown).not.toContain('s3cret');
    const next = prompter.ask('Visible');
    input.write('shown-text\n');
    expect(await next).toBe('shown-text');
    expect(shown).toContain('shown-text');
    prompter.close();
  });
});

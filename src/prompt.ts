import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

export interface Prompter {
  ask: (question: string, fallback?: string) => Promise<string>;
  // Reads a line without echoing it (an API key).
  askSecret: (question: string) => Promise<string>;
  close: () => void;
}

export function createPrompter(input: Readable, output: Writable): Prompter {
  let muted = false;
  // readline echoes what is typed to its output: this one drops the echo while a secret is being read.
  const echo = new Writable({ write(chunk: Buffer, _encoding, done) { if (!muted) output.write(chunk); done(); } });
  const lines = createInterface({ input, output: echo, terminal: (input as { isTTY?: boolean }).isTTY === true })[Symbol.asyncIterator]();
  const line = async () => ((await lines.next()).value ?? '').trim();
  return {
    async ask(question, fallback) {
      output.write(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `);
      return (await line()) || fallback || '';
    },
    async askSecret(question) {
      output.write(`${question}: `);
      muted = true;
      try {
        return await line();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    close: () => { void lines.return?.(); },
  };
}

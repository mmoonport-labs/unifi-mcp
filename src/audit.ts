import { appendFileSync } from 'node:fs';

// Every applied change is reported to stderr and, when UNIFI_AUDIT_LOG names a file, appended to it as one JSON object per line
// ({"time", "event"}). The lines were redacted before they got here. The file is created readable only by the user. A log that cannot
// be written is reported, but never undoes or hides a change that has already been made.
export function makeAudit(env: NodeJS.ProcessEnv, stderr: (text: string) => void, now: () => Date = () => new Date()): (line: string) => void {
  const file = env.UNIFI_AUDIT_LOG?.trim() || undefined;
  return (line) => {
    stderr(`unifi-mcp: ${line}\n`);
    if (file === undefined) return;
    try {
      appendFileSync(file, `${JSON.stringify({ time: now().toISOString(), event: line })}\n`, { mode: 0o600 });
    } catch (error) {
      stderr(`unifi-mcp: could not write the audit log ${file} (${(error as Error).message})\n`);
    }
  };
}

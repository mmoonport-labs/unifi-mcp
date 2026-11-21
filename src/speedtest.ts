import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UdmError, type Udm } from './udm.js';

export interface SpeedtestOptions {
  readOnly?: boolean;
  audit?: (line: string) => void;
  // How often the gateway is asked how the test is going, and when to give up (tests use small values).
  pollMs?: number;
  timeoutMs?: number;
}

interface Status { status_summary?: number; xput_download?: number; xput_upload?: number; latency?: number; runtime?: number; rundate?: number; timestamp?: number }

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const NICE = [100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 100_000];
const WIDTH = 10;

// The scale of a bar: what the caller asked for, widened to the next round number if a reading goes past it.
export const scaleFor = (value: number, scale: number): number => (value <= scale ? scale : NICE.find((n) => n >= value) ?? Math.ceil(value / 100_000) * 100_000);

export function bar(value: number, scale: number): string {
  const filled = Math.min(WIDTH, Math.round((value / scale) * WIDTH));
  return `[${'█'.repeat(filled)}${'░'.repeat(WIDTH - filled)}]`;
}

const num = (value: number | undefined): number => value ?? 0;

export function line(status: Status, scale: number): string {
  const [down, up] = [num(status.xput_download), num(status.xput_upload)];
  return `↓ ${String(down)} Mbps ${bar(down, scale)} ${String(scale)}   ↑ ${String(up)} Mbps ${bar(up, scale)} ${String(scale)}   ${String(num(status.latency))} ms`;
}

const stamp = (status: Status): number => num(status.rundate ?? status.timestamp);
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// The speed test, with live progress: starts it, then asks the gateway how it is going once a second and sends each reading to the client
// as an MCP progress notification (what a client does with those is up to it), and answers with the final result.
export function registerSpeedtest(server: McpServer, udm: Udm, options: SpeedtestOptions): void {
  const audit = options.audit ?? (() => undefined);
  const [pollMs, timeoutMs] = [options.pollMs ?? 1000, options.timeoutMs ?? 90_000];
  const path = udm.legacy('cmd/devmgr');
  const status = async (): Promise<Status> => ((await udm.send<{ data?: Status[] }>('POST', path, { cmd: 'speedtest-status' })).data ?? [])[0] ?? {};

  server.registerTool('unifi_speedtest', {
    description: 'CHANGES THE ROUTER\'S LOAD: starts a speed test of the internet connection, which uses the whole WAN link for about 15 to 30 seconds, and reports live progress '
      + '(download and upload in Mbps against a scale, and latency) while it runs. Defaults to a dry run; apply with dry_run=false AND confirm=true, only after the owner has said to. '
      + 'Answers with the final download, upload and latency.',
    inputSchema: {
      dry_run: z.boolean().default(true).describe('true (the default) only shows the request'),
      confirm: z.boolean().default(false).describe('required together with dry_run=false'),
      scale_mbps: z.number().min(10).max(100_000).optional().describe('the full length of the progress bars in Mbps (default 2500; widened if a reading goes past it)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra) => {
    try {
      if (options.readOnly) return failure('The server is read-only (started with UNIFI_READ_ONLY=1).');
      const request = { method: 'POST', path, body: { cmd: 'speedtest' } };
      if (args.dry_run) return text({ dryRun: true, request, warning: 'The test uses the whole WAN link for about 15 to 30 seconds.', next: 'Pass dry_run=false and confirm=true to apply.' });
      if (!args.confirm) return failure('Not applied: confirm=true is required to start a speed test.');
      const previous = stamp(await status());
      await udm.send('POST', path, request.body);
      audit(`applied speedtest POST ${path} body ${JSON.stringify(request.body)}`);
      const started = Date.now();
      const token = extra._meta?.progressToken;
      let [scale, polls, sawRunning, shown] = [args.scale_mbps ?? 2500, 0, false, ''];
      while (Date.now() - started < timeoutMs) {
        await sleep(pollMs);
        if (extra.signal.aborted) return failure('Cancelled. The gateway may still finish the test: read legacy_get_speedtest_status.');
        const now = await status();
        sawRunning ||= now.status_summary === 1;
        scale = scaleFor(Math.max(num(now.xput_download), num(now.xput_upload)), scale);
        shown = line(now, scale);
        polls += 1;
        if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: polls, message: shown } });
        if (now.status_summary === 2 && (sawRunning || stamp(now) > previous)) {
          return text({ applied: true, result: { download_mbps: num(now.xput_download), upload_mbps: num(now.xput_upload), latency_ms: num(now.latency), test_seconds: num(now.runtime) }, display: shown });
        }
      }
      return failure(`The speed test did not finish within ${String(Math.round(timeoutMs / 1000))} s. Last reading: ${shown === '' ? 'none' : shown}. Read legacy_get_speedtest_status for the result later.`);
    } catch (error) {
      if (error instanceof UdmError) return failure(error.message);
      throw error;
    }
  });
}

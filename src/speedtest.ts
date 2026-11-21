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

export interface Scales { down: number; up: number }

export function line(status: Status, scales: Scales): string {
  const [down, up] = [num(status.xput_download), num(status.xput_upload)];
  return `↓ ${String(down)} Mbps ${bar(down, scales.down)} ${String(scales.down)}   ↑ ${String(up)} Mbps ${bar(up, scales.up)} ${String(scales.up)}   ${String(num(status.latency))} ms`;
}

interface Network { purpose?: string; wan_networkgroup?: string; wan_provider_capabilities?: { download_kilobits_per_second?: number; upload_kilobits_per_second?: number } }

// The speeds the owner entered for the main internet connection (Mbps), if the gateway has them: the WAN network, else the first one.
export function providerSpeeds(networks: Network[]): Scales | undefined {
  const wans = networks.filter((network) => network.purpose === 'wan');
  const caps = (wans.find((network) => network.wan_networkgroup === 'WAN') ?? wans[0])?.wan_provider_capabilities;
  const [down, up] = [(caps?.download_kilobits_per_second ?? 0) / 1000, (caps?.upload_kilobits_per_second ?? 0) / 1000];
  return down > 0 && up > 0 ? { down, up } : undefined;
}

const stamp = (status: Status): number => num(status.rundate ?? status.timestamp);
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// The speed test, with live progress: starts it, then asks the gateway how it is going once a second and sends each reading to the client
// as an MCP progress notification (what a client does with those is up to it), and answers with the final result.
export function registerSpeedtest(server: McpServer, udm: Udm, options: SpeedtestOptions): void {
  const audit = options.audit ?? (() => undefined);
  const [pollMs, timeoutMs] = [options.pollMs ?? 1000, options.timeoutMs ?? 90_000];
  const path = udm.legacy('cmd/devmgr');
  const networks = async (): Promise<Network[]> => {
    try {
      const { data } = await udm.get<{ data?: unknown }>(udm.legacy('rest/networkconf'));
      return Array.isArray(data) ? data as Network[] : [];
    } catch {
      return []; // only a nicer scale is lost
    }
  };
  const status = async (): Promise<Status> => ((await udm.send<{ data?: Status[] }>('POST', path, { cmd: 'speedtest-status' })).data ?? [])[0] ?? {};

  server.registerTool('unifi_speedtest', {
    description: 'CHANGES THE ROUTER\'S LOAD: starts a speed test of the internet connection, which uses the whole WAN link for about 15 to 30 seconds, and reports live progress '
      + '(download and upload in Mbps against the speeds set for the main WAN in UniFi, or scale_mbps, and latency) while it runs. Defaults to a dry run; apply with dry_run=false AND confirm=true, only after the owner has said to. '
      + 'Answers with the final download, upload and latency.',
    inputSchema: {
      dry_run: z.boolean().default(true).describe('true (the default) only shows the request'),
      confirm: z.boolean().default(false).describe('required together with dry_run=false'),
      scale_mbps: z.number().min(10).max(100_000).optional().describe('the full length of both progress bars in Mbps. Default: the download and upload speeds set for the main WAN in UniFi, else 2500. Widened if a reading goes past it'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra) => {
    try {
      if (options.readOnly) return failure('The server is read-only (started with UNIFI_READ_ONLY=1).');
      const request = { method: 'POST', path, body: { cmd: 'speedtest' } };
      if (args.dry_run) return text({ dryRun: true, request, warning: 'The test uses the whole WAN link for about 15 to 30 seconds.', next: 'Pass dry_run=false and confirm=true to apply.' });
      if (!args.confirm) return failure('Not applied: confirm=true is required to start a speed test.');
      const previous = stamp(await status());
      const expected = providerSpeeds(await networks());
      await udm.send('POST', path, request.body);
      audit(`applied speedtest POST ${path} body ${JSON.stringify(request.body)}`);
      const started = Date.now();
      const token = extra._meta?.progressToken;
      let scales = args.scale_mbps === undefined ? expected ?? { down: 2500, up: 2500 } : { down: args.scale_mbps, up: args.scale_mbps };
      let [polls, sawRunning, shown] = [0, false, ''];
      while (Date.now() - started < timeoutMs) {
        await sleep(pollMs);
        if (extra.signal.aborted) return failure('Cancelled. The gateway may still finish the test: read legacy_get_speedtest_status.');
        const now = await status();
        sawRunning ||= now.status_summary === 1;
        scales = { down: scaleFor(num(now.xput_download), scales.down), up: scaleFor(num(now.xput_upload), scales.up) };
        shown = line(now, scales);
        polls += 1;
        if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: polls, message: shown } });
        // The gateway marks the test finished (status_summary 2) one reading before it fills in the upload speed, so wait for that too.
        if (now.status_summary === 2 && num(now.xput_upload) > 0 && (sawRunning || stamp(now) > previous)) {
          const percent = (got: number | undefined, want: number) => Math.round((num(got) / want) * 100);
          return text({
            applied: true,
            result: { download_mbps: num(now.xput_download), upload_mbps: num(now.xput_upload), latency_ms: num(now.latency), test_seconds: num(now.runtime) },
            ...(expected === undefined ? {} : { expected: { download_mbps: expected.down, upload_mbps: expected.up, download_percent: percent(now.xput_download, expected.down), upload_percent: percent(now.xput_upload, expected.up) } }),
            display: shown,
          });
        }
      }
      return failure(`The speed test did not finish within ${String(Math.round(timeoutMs / 1000))} s. Last reading: ${shown === '' ? 'none' : shown}. Read legacy_get_speedtest_status for the result later.`);
    } catch (error) {
      if (error instanceof UdmError) return failure(error.message);
      throw error;
    }
  });
}

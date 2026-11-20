import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerApiTools } from './api-tools.js';
import { SPEC_VERSIONS } from './catalog.js';
import { Udm, UdmError } from './udm.js';

export interface ServerOptions {
  // Refuse every change (UNIFI_READ_ONLY=1). Otherwise the write tools are available and the client's permission rules
  // (allow / ask / deny by tool name) decide whether each call goes ahead; the dry-run and confirm guard still applies.
  readOnly?: boolean;
  // Every applied change is written here (stderr in the real server). Never the key.
  audit?: (line: string) => void;
}

interface Envelope<T> {
  meta?: { rc?: string; msg?: string };
  data?: T[];
}

export interface PortForward {
  _id: string;
  name?: string;
  enabled?: boolean;
  pfwd_interface?: string;
  dst_port?: string;
  fwd?: string;
  fwd_port?: string;
  proto?: string;
  src?: string;
  destination_ip?: string;
  log?: boolean;
  [key: string]: unknown;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));

// A private (RFC 1918) IPv4 address: a forward target is always a machine on the LAN, never an address out on the internet.
export function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// One port ("443") or a range ("8000-8010"), each 1 to 65535, as the UDM stores them (strings).
export function isPortSpec(value: string): boolean {
  const ports = value.split('-');
  return ports.length <= 2 && ports.every((port) => /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535)
    && (ports.length === 1 || Number(ports[0]) < Number(ports[1]));
}

const CHANGES = ['enabled', 'fwd', 'fwd_port', 'dst_port'] as const;
// The id goes into the request path, so it stays strictly shaped: the 24-hex ids the gateway used until 2026-11-11, or the
// lowercase UUIDs it returned on 2026-11-12 (FS-308).
export const RULE_ID_PATTERN = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function createServer(udm: Udm, options: ServerOptions = {}): McpServer {
  const audit = options.audit ?? (() => undefined);
  const server = new McpServer({ name: 'unifi-mcp', version: '0.1.0' });

  const guarded = (work: () => Promise<ReturnType<typeof text>>) => async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UdmError) return failure(error.message);
      throw error;
    }
  };

  const rows = async <T>(path: string): Promise<T[]> => ((await udm.get<Envelope<T>>(udm.legacy(path))).data ?? []);

  server.registerTool('unifi_info', {
    description: 'The gateway\'s Network and Protect application versions, its sites, the versions of the API specs this server has bundled, and specDrift: the applications whose version differs from the spec (read-only). '
      + 'A spec that differs from the gateway is refreshed with scripts/update-spec.sh (see the unifi skill).',
  }, guarded(async () => {
    const info = await udm.get<{ applicationVersion?: string }>('/proxy/network/integration/v1/info');
    const sites = await udm.get('/proxy/network/integration/v1/sites');
    // Protect may not be installed (or its API not reachable): that is null, not an error.
    const protect = await udm.get<{ applicationVersion?: string }>('/proxy/protect/integration/v1/meta/info').catch(() => null);
    const gateway = { network: info.applicationVersion, protect: protect?.applicationVersion };
    // A spec you supplied yourself (UNIFI_PROTECT_SPEC_FILE) is yours to keep current.
    const specDrift = (['network', 'protect'] as const)
      .filter((app) => gateway[app] !== undefined && SPEC_VERSIONS[app] !== 'custom' && gateway[app] !== SPEC_VERSIONS[app])
      .map((app) => ({ app, gateway: gateway[app], spec: SPEC_VERSIONS[app] }));
    return text({ info, sites, protect, specs: SPEC_VERSIONS, specDrift });
  }));

  server.registerTool('unifi_list_port_forwards', {
    description: 'Every port-forward rule: id, name, enabled, WAN address (destination_ip), WAN port (dst_port), the LAN target (fwd, fwd_port), protocol and source (read-only).',
  }, guarded(async () => text((await rows<PortForward>('rest/portforward')).map((rule) => pick(rule,
    ['_id', 'name', 'enabled', 'pfwd_interface', 'destination_ip', 'dst_port', 'fwd', 'fwd_port', 'proto', 'src', 'log'])))));

  server.registerTool('unifi_health', {
    description: 'Site health by subsystem (wan, lan, wlan, www, vpn): status, WAN address, client counts and throughput (read-only).',
  }, guarded(async () => text((await rows<Record<string, unknown>>('stat/health')).map((row) => pick(row,
    ['subsystem', 'status', 'wan_ip', 'gw_name', 'num_user', 'num_guest', 'num_adopted', 'num_disconnected', 'rx_bytes-r', 'tx_bytes-r'])))));

  server.registerTool('unifi_list_devices', {
    description: 'Adopted UniFi devices: name, model, type, firmware, state, address, uptime (read-only).',
  }, guarded(async () => text((await rows<Record<string, unknown>>('stat/device')).map((row) => pick(row,
    ['name', 'model', 'type', 'version', 'state', 'ip', 'uptime'])))));

  server.registerTool('unifi_list_clients', {
    description: 'Connected clients: name, address, MAC, wired or not, network and last seen (read-only).',
  }, guarded(async () => text((await rows<Record<string, unknown>>('stat/sta')).map((row) => pick(row,
    ['hostname', 'name', 'ip', 'mac', 'is_wired', 'network', 'last_seen'])))));

  server.registerTool('unifi_set_port_forward', {
    description: 'CHANGES THE ROUTER. Change one port-forward rule: enable or disable it, or change its LAN target (fwd, fwd_port) or WAN port (dst_port). '
      + 'Defaults to a dry run that shows before and after; to apply, pass dry_run=false AND confirm=true, '
      + 'and only after the owner has said to. Nothing here creates or deletes a rule. The reply carries the previous values so a revert is one more call. '
      + 'Uses the gateway\'s older ("legacy") rest/portforward endpoint, as the community clients do; unverified against a real write until the owner\'s first test.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      id: z.string().regex(RULE_ID_PATTERN, 'the rule\'s _id from unifi_list_port_forwards (24 hex characters, or a UUID since the gateway\'s 2026-11-12 update)'),
      enabled: z.boolean().optional(),
      fwd: z.string().optional().describe('LAN address to forward to (private IPv4)'),
      fwd_port: z.string().optional().describe('port or range on the target'),
      dst_port: z.string().optional().describe('WAN port or range'),
      dry_run: z.boolean().default(true),
      confirm: z.boolean().default(false),
    },
  }, async (args) => {
    try {
      if (options.readOnly) return failure('The server is read-only (started with UNIFI_READ_ONLY=1).');
      const changes = Object.fromEntries(CHANGES.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
      if (Object.keys(changes).length === 0) return failure(`Nothing to change: pass at least one of ${CHANGES.join(', ')}.`);
      if (args.fwd !== undefined && !isPrivateIpv4(args.fwd)) return failure('fwd must be a private LAN IPv4 address (10.x, 172.16-31.x or 192.168.x).');
      for (const key of ['fwd_port', 'dst_port'] as const) {
        const value = args[key];
        if (value !== undefined && !isPortSpec(value)) return failure(`${key} must be a port from 1 to 65535 or a range like 8000-8010.`);
      }
      const rule = (await rows<PortForward>('rest/portforward')).find((candidate) => candidate._id === args.id);
      if (rule === undefined) return failure('No port-forward rule has that id.');
      const before = pick(rule, Object.keys(changes));
      const summary = { rule: rule.name, destination_ip: rule.destination_ip, before, after: changes };
      if (args.dry_run) return text({ dryRun: true, ...summary, next: 'Pass dry_run=false and confirm=true to apply.' });
      if (!args.confirm) return failure('Not applied: confirm=true is required to change the router.');
      await udm.put(udm.legacy(`rest/portforward/${args.id}`), { ...rule, ...changes });
      audit(`applied to port-forward ${args.id} (${String(rule.name)}): ${JSON.stringify(before)} -> ${JSON.stringify(changes)}`);
      return text({ applied: true, ...summary, revert: { id: args.id, ...before, dry_run: false, confirm: true } });
    } catch (error) {
      if (error instanceof UdmError) return failure(error.message);
      throw error;
    }
  });

  registerApiTools(server, udm, options);

  return server;
}

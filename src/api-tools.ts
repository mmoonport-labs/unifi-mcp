import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findOperation, hasGet, search, SPEC_VERSIONS, tags, validateBody, type Operation, type Risk } from './catalog.js';
import { Udm, UdmError, type BinaryReply } from './udm.js';

export interface ApiToolOptions {
  // Refuse every change (UNIFI_READ_ONLY=1). Otherwise the client's permission rules decide: unifi_write and unifi_delete are
  // separate tools so they can be allowed, asked about or denied one by one.
  readOnly?: boolean;
  audit?: (line: string) => void;
}

type Json = Record<string, unknown>;

const TOOL_FOR: Record<Risk, string> = { read: 'unifi_call', write: 'unifi_write', delete: 'unifi_delete' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Path values go into the request path, so they stay strictly shaped.
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
// A reply bigger than this would flood the model's context: ask for fewer rows or fields instead.
export const MAX_REPLY_CHARS = 40_000;

// Secrets in a gateway record (a Wi-Fi network's x_passphrase, a password, a pre-shared key, a token) never reach the model, the
// transcript or the audit log: any string under a key that looks like one is replaced. Only strings are touched, so a schema that
// merely names such a property (describe_operation) is left alone. What is sent to the gateway is not redacted, only what is shown.
const SECRET_KEY = /passphrase|passwd|password|secret|psk|private_?key|token|shadow|api_?key|iapp_key/i;
export const REDACTED = '[redacted]';

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' && SECRET_KEY.test(key) ? REDACTED : redact(item)]));
}

const text = (value: unknown) => {
  const body = JSON.stringify(redact(value), null, 2);
  if (body.length > MAX_REPLY_CHARS) return failure(`The reply is ${String(body.length)} characters, too big to return. Pass fields to keep only some keys, or query limit/filter to ask for fewer rows.`);
  return { content: [{ type: 'text' as const, text: body }] };
};
// A camera snapshot: sent back as an image the model can look at. Bigger than this and it is refused rather than flooding the context.
export const MAX_IMAGE_BYTES = 4_000_000;
const image = ({ data, contentType }: BinaryReply) => (data.length > MAX_IMAGE_BYTES
  ? failure(`The image is ${String(data.length)} bytes, too big to return.`)
  : { content: [{ type: 'image' as const, data: data.toString('base64'), mimeType: contentType.split(';')[0]! }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const pick = (row: unknown, fields: string[]) => (typeof row === 'object' && row !== null && !Array.isArray(row)
  ? Object.fromEntries(fields.filter((key) => key in row).map((key) => [key, (row as Json)[key]]))
  : row);

// The rows of an answer: the official API wraps them as {data: [...], offset, limit, totalCount}, the legacy API as {meta, data: [...]}.
export function trim(answer: unknown, fields: string[] | undefined): unknown {
  if (fields === undefined) return answer;
  if (Array.isArray(answer)) return answer.map((row) => pick(row, fields));
  if (typeof answer === 'object' && answer !== null && Array.isArray((answer as Json).data)) {
    return { ...(answer as Json), data: ((answer as Json).data as unknown[]).map((row) => pick(row, fields)) };
  }
  return pick(answer, fields);
}

export function registerApiTools(server: McpServer, udm: Udm, options: ApiToolOptions): void {
  const audit = options.audit ?? (() => undefined);
  let siteId: Promise<string> | undefined;

  // The official API addresses a site by UUID. The configured site name (default "default") is looked up once.
  const defaultSiteId = (): Promise<string> => (siteId ??= (async () => {
    const sites = ((await udm.get<{ data?: Array<{ id: string; name?: string; internalReference?: string }> }>('/proxy/network/integration/v1/sites')).data ?? []);
    const wanted = udm.site.toLowerCase();
    const site = sites.find((candidate) => candidate.internalReference?.toLowerCase() === wanted || candidate.name?.toLowerCase() === wanted) ?? (sites.length === 1 ? sites[0] : undefined);
    if (site === undefined) throw new UdmError(`Could not find the site "${udm.site}" among the gateway's sites; pass siteId.`);
    return site.id;
  })().catch((error: unknown) => { siteId = undefined; throw error; }));

  async function resolvePath(op: Operation, given: Record<string, string>): Promise<string> {
    let path = op.api === 'legacy' ? udm.legacy(op.path) : op.path;
    for (const param of op.params.filter((p) => p.in === 'path')) {
      let value = given[param.name];
      if (value === undefined && param.name === 'siteId') value = await defaultSiteId();
      if (value === undefined) throw new UdmError(`Missing path_params.${param.name}.`);
      const shape = param.schema.format === 'uuid' ? UUID : SEGMENT;
      if (!shape.test(value)) throw new UdmError(`path_params.${param.name} is not a valid ${param.schema.format === 'uuid' ? 'UUID' : 'id'}.`);
      path = path.replace(`{${param.name}}`, encodeURIComponent(value));
    }
    return path;
  }

  function queryString(op: Operation, query: Record<string, string | number | boolean>): string {
    const declared = op.params.filter((p) => p.in === 'query');
    const unknown = Object.keys(query).filter((key) => !declared.some((p) => p.name === key));
    if (unknown.length > 0) throw new UdmError(`Unknown query parameter(s) for ${op.id}: ${unknown.join(', ')}. Declared: ${declared.map((p) => p.name).join(', ') || 'none'}.`);
    const missing = declared.filter((p) => p.required && !(p.name in query));
    if (missing.length > 0) throw new UdmError(`Missing query parameter(s): ${missing.map((p) => p.name).join(', ')}.`);
    const encoded = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
    return encoded === '' ? '' : `?${encoded}`;
  }

  // The current state of the record a write touches (when its path has a GET), so a dry run can show before and after (and a legacy PUT can merge over it).
  async function current(op: Operation, path: string): Promise<unknown> {
    if (op.api === 'official') return op.method !== 'POST' && hasGet(op) ? udm.get(path) : undefined;
    if (!op.path.endsWith('/{id}')) return undefined;
    const parent = path.slice(0, path.lastIndexOf('/'));
    const id = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    const rows = ((await udm.get<{ data?: Json[] }>(parent)).data ?? []);
    const row = rows.find((candidate) => candidate._id === id);
    if (row === undefined) throw new UdmError('No record has that id.');
    return row;
  }

  server.registerTool('unifi_search_api', {
    description: `Find operations of the UniFi gateway's APIs: Network (official integration API ${SPEC_VERSIONS.network}, plus legacy endpoints for firewall, networks, Wi-Fi, DHCP reservations, port forwards, commands) and Protect (official API ${SPEC_VERSIONS.protect}: cameras, snapshots, sensors, lights, sirens, chimes, arm profiles, PTZ). `
      + 'Pass words (e.g. "firewall policy", "wifi", "camera snapshot") and optionally app (network|protect), tag, risk (read|write|delete) or api (official|legacy). Returns operation ids to give to unifi_describe_operation and unifi_call. Read-only.',
    inputSchema: {
      query: z.string().optional().describe('words that must all appear in the id, summary, path or tags'),
      tag: z.string().optional().describe('e.g. Firewall, Networks, Legacy'),
      risk: z.enum(['read', 'write', 'delete']).optional(),
      api: z.enum(['official', 'legacy']).optional(),
      app: z.enum(['network', 'protect']).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
  }, (args) => text({ tags: tags(), ...search(args.query, { tag: args.tag, risk: args.risk, api: args.api, app: args.app }, args.limit) }));

  server.registerTool('unifi_describe_operation', {
    description: 'Everything needed to call one operation: path and query parameters, the full request body schema and what the call does. Use an id from unifi_search_api. Read-only.',
    inputSchema: { operation: z.string() },
  }, (args) => {
    const op = findOperation(args.operation);
    if (op === undefined) return failure(`No operation "${args.operation}". Use unifi_search_api to find one.`);
    const { params, bodySchema, hasBody, bodyRequired, merge, ...rest } = op;
    return text({
      ...rest,
      path_params: params.filter((p) => p.in === 'path').map(({ in: _in, ...p }) => p),
      query: params.filter((p) => p.in === 'query').map(({ in: _in, ...p }) => p),
      body: hasBody ? { required: bodyRequired, schema: bodySchema } : undefined,
      notes: [
        op.unsupported === undefined ? `Run it with ${TOOL_FOR[op.risk]}.` : `This server cannot run it: it is ${op.unsupported}.`,
        op.response === 'image' ? 'The answer is an image, returned as an image.' : undefined,
        op.risk === 'read' ? undefined : 'Changes the router: it dry-runs by default; apply with dry_run=false and confirm=true, only after the owner says to.',
        merge ? 'Send only the fields to change; they are merged over the current record.' : undefined,
        op.params.some((p) => p.name === 'siteId') ? 'siteId may be left out: the configured site is used.' : undefined,
      ].filter(Boolean),
    });
  });

  const shape = {
    operation: z.string().describe('operation id'),
    path_params: z.record(z.string(), z.string()).optional().describe('values for {placeholders} in the path; siteId defaults to the configured site'),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.record(z.string(), z.unknown()).optional().describe('JSON request body (see unifi_describe_operation)'),
    fields: z.array(z.string()).optional().describe('keep only these keys of each row of the reply'),
  };
  const changeShape = {
    ...shape,
    dry_run: z.boolean().default(true).describe('true (the default) only shows the request and the current record'),
    confirm: z.boolean().default(false).describe('required together with dry_run=false'),
  };
  type CallArgs = { operation: string; path_params?: Record<string, string>; query?: Record<string, string | number | boolean>; body?: Json; fields?: string[]; dry_run?: boolean; confirm?: boolean };

  // One handler for the three tools. Each accepts only its own kind of operation, so a client's permission rules (allow / ask / deny
  // by tool name) can tell a read from a change from a delete.
  const run = (tool: Risk) => async (args: CallArgs) => {
    try {
      const op = findOperation(args.operation);
      if (op === undefined) return failure(`No operation "${args.operation}". Use unifi_search_api to find one.`);
      if (op.unsupported !== undefined) return failure(`${op.id} cannot be run here: it is ${op.unsupported}.`);
      if (op.risk !== tool) return failure(`${op.id} is a ${op.risk} operation: use ${TOOL_FOR[op.risk]}.`);
      if (tool !== 'read' && options.readOnly) return failure('The server is read-only (started with UNIFI_READ_ONLY=1).');
      if (args.body !== undefined && !op.hasBody) return failure(`${op.id} takes no body.`);
      if (args.body === undefined && op.bodyRequired) return failure(`${op.id} needs a body (see unifi_describe_operation).`);
      const { errors, warnings } = args.body === undefined ? { errors: [], warnings: [] } : validateBody(op, args.body);
      if (errors.length > 0) return failure(`The body does not match ${op.id}'s schema: ${errors.join('; ')}. See unifi_describe_operation.`);
      // Unknown fields do not block (the gateway can be newer than the spec) but are shown, so a typo on an optional field is seen.
      const notes = warnings.length === 0 ? {} : { warnings };
      const path = `${await resolvePath(op, args.path_params ?? {})}${queryString(op, args.query ?? {})}`;
      if (tool === 'read' && op.response === 'image') return image(await udm.getBinary(path));
      if (tool === 'read') return text(trim(op.fixedBody === undefined ? await udm.get(path) : await udm.send(op.method, path, op.fixedBody), args.fields));
      const before = await current(op, path.split('?')[0]!);
      const body = op.fixedBody ?? (op.merge ? { ...(before as Json), ...args.body } : args.body);
      const request = { method: op.method, path, body };
      if (args.dry_run !== false) return text({ dryRun: true, operation: op.id, request, before, ...notes, next: 'Pass dry_run=false and confirm=true to apply.' });
      if (args.confirm !== true) return failure('Not applied: confirm=true is required to change the router.');
      const answer = await udm.send(op.method, path, body);
      audit(`applied ${op.id} ${op.method} ${path}${tool === 'delete' ? '' : ` body ${JSON.stringify(redact(op.fixedBody ?? args.body))}`}; before ${JSON.stringify(redact(before))}`);
      return text({ applied: true, operation: op.id, request, before, ...notes, answer: trim(answer, args.fields) });
    } catch (error) {
      if (error instanceof UdmError) return failure(error.message);
      throw error;
    }
  };

  server.registerTool('unifi_call', {
    description: 'Run a READ operation found with unifi_search_api (risk "read"). Changes nothing. Use fields to keep only some keys of each row, and query limit/filter on big lists. Writes and deletes use unifi_write and unifi_delete.',
    inputSchema: shape,
    annotations: { readOnlyHint: true },
  }, run('read'));

  server.registerTool('unifi_write', {
    description: 'CHANGES THE ROUTER: run a create or update operation (risk "write"). Defaults to a dry run that shows the request and the current record; apply with dry_run=false AND confirm=true, '
      + 'only after the owner has said to. An applied change returns the previous record so it can be undone.',
    inputSchema: changeShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, run('write'));

  server.registerTool('unifi_delete', {
    description: 'DELETES something on the router (risk "delete"). Defaults to a dry run that shows the current record; apply with dry_run=false AND confirm=true, only after the owner has said to. The reply carries the deleted record.',
    inputSchema: changeShape,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, run('delete'));
}

# unifi-mcp

> **Unofficial.** Not affiliated with or endorsed by Ubiquiti Inc. UniFi and UniFi Protect are trademarks of Ubiquiti Inc. This server can change your network: changes are a dry run unless you confirm them, many write operations have not been tried on real gateways, and you use it at your own risk (MIT licence, no warranty). Report security problems as described in `SECURITY.md`.

A small [MCP](https://modelcontextprotocol.io) server for a UniFi gateway's **local** API (a UDM, UDM Pro, UCG and so on, Network 9+), written so that one person can read all of it. Nothing leaves your network.

## Install

Once published (not yet): `npx -y @mmoonport-labs/unifi-mcp`, with `UNIFI_URL`, `UNIFI_API_KEY` and `UNIFI_CERT_SHA256` in the environment. For Claude Code:

```sh
claude mcp add unifi -e UNIFI_URL=https://192.168.1.1 -e UNIFI_API_KEY=<key> -e UNIFI_CERT_SHA256=<fingerprint> -- npx -y @mmoonport-labs/unifi-mcp
```

Until then, build from source as below. Needs Node 24 or newer.

## Tools

| Tool | What it does |
|---|---|
| `unifi_info` | Network and Protect versions, sites, the bundled spec versions, and `specDrift` (apps whose spec differs from the gateway; the skill refreshes them) |
| `unifi_list_port_forwards` | every port-forward rule (id, name, enabled, WAN address and port, LAN target, protocol) |
| `unifi_health` | site health by subsystem |
| `unifi_list_devices` | adopted devices (name, model, firmware, state) |
| `unifi_list_clients` | connected clients |
| `unifi_set_port_forward` | **changes the router**: enable or disable a rule, or change its LAN target (`fwd`, `fwd_port`) or WAN port (`dst_port`) |

Three more tools cover the rest of the gateway API without a tool per endpoint:

| Tool | What it does |
|---|---|
| `unifi_search_api` | find operations by words, tag, risk or api |
| `unifi_describe_operation` | parameters and full request-body schema of one operation |
| `unifi_call` | run a **read** operation |
| `unifi_write` | **changes the router**: run a create or update operation; dry run by default |
| `unifi_delete` | **deletes**: run a delete operation; dry run by default |

The catalog is every operation of Ubiquiti's official Network integration API (`spec/integration.json`, 11.0.99, 73 operations) and Protect integration API (`spec/protect.json`, 7.3.74, 74 operations: cameras, snapshots, sensors, lights, sirens, chimes, arm profiles, PTZ), refreshed with `scripts/update-spec.sh network|protect <version>` (Ubiquiti's docs CDN, which stops at Network 10.3.58, then the community repo [beezly/unifi-apis](https://github.com/beezly/unifi-apis), which extracts a spec from every controller release: the 11.0.99 file came from there; spec text reaches the model, so review the diff), plus a table of legacy Network endpoints (networks, firewall rules and groups, Wi-Fi, DHCP reservations, static routes, port forwards, device and client commands). `unifi_call` can trim replies with `fields`, refuses replies over 40,000 characters, validates path ids and query names, fills in `siteId`, **checks write bodies against the spec's schema** before anything is sent (a missing required field, a wrong type, a bad enum value, UUID or range, or an unknown variant blocks the call; an unknown field is only shown as a `warning`, because the gateway is newer than the spec), and **redacts secrets** (strings under keys such as `x_passphrase`, `password`, `psk`, `token`) from every reply and the audit log; the real value is still sent to the gateway on a write. Each tool accepts only its own kind of operation, so Claude Code's permission rules (allow, ask, deny by tool name) can tell a read from a change from a delete; see "Permissions" below. A camera snapshot comes back as an image. Operations this server cannot run (the two Protect WebSocket streams, the Protect file upload) are listed and explained. An irreversible action ("Permanently disable camera microphone") is classed as a delete. A project skill (`.claude/skills/unifi`) teaches Claude the workflow.

### How the write tool is guarded

1. **Gated by your permissions.** The write tools are always there; Claude Code asks you before each call (see "Permissions"). `UNIFI_READ_ONLY=1` refuses every change regardless.
2. **Dry run by default.** It reads the rule and returns before and after; nothing is sent.
3. To apply, the call needs `dry_run=false` **and** `confirm=true`. (The tool description tells the model to do this only after the owner says to.)
4. `fwd` must be a private LAN address; ports are checked; the rule id must exist.
5. The reply carries the **previous values** and a ready `revert` call. Every applied change is logged to stderr (never the key).
6. It sends the whole rule back with only your fields changed, using the gateway's older ("legacy") `rest/portforward` endpoint, because the official integration API has no port-forward endpoints we could find. **The first real write has not been tried** (see "Status").

## Configuration (environment)

| Variable | |
|---|---|
| `UNIFI_URL` | required, e.g. `https://192.168.1.1` |
| `UNIFI_API_KEY` | required. Create it in UniFi: Settings, Control Plane, Integrations. Only ever sent as the `X-API-KEY` header |
| `UNIFI_CERT_SHA256` | recommended: pin the gateway's own certificate (its SHA-256 fingerprint). The key is not sent to any other certificate |
| `UNIFI_INSECURE` | `1` to accept the self-signed certificate without pinning |
| `UNIFI_SITE` | site name, default `default` |
| `UNIFI_SPEC_FILE`, `UNIFI_PROTECT_SPEC_FILE` | path to another copy of the Network or Protect OpenAPI spec (a newer download or one corrected by hand), used instead of the bundled one |
| `UNIFI_READ_ONLY` | `1` to refuse every change (`unifi_write`, `unifi_delete`, `unifi_set_port_forward`), whatever the permissions say |

Get the fingerprint: `openssl s_client -connect 192.168.1.1:443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`

## Use with Claude Code

```sh
npm ci && npm run build
claude mcp add unifi --scope user \
  -e UNIFI_URL=https://192.168.1.1 -e UNIFI_CERT_SHA256=<fingerprint> \
  -- ./scripts/run.sh
```

`scripts/run.sh` (macOS only; on other systems set `UNIFI_API_KEY` in the environment) reads the key from the macOS Keychain, so it is in neither the repo nor Claude's config:

```sh
security add-generic-password -a "$USER" -s unifi-mcp -w     # asks for the key
```

## Use with other MCP clients

The server speaks standard MCP over stdio, so any client that can start a local server works. It needs `UNIFI_URL`, `UNIFI_API_KEY` and, better than skipping the check, `UNIFI_CERT_SHA256` (see Configuration). Build it first (`npm ci && npm run build`) and use the absolute path to `dist/index.js`. The generic entry, which most clients' JSON config takes under `mcpServers` (Claude Desktop, Cursor, Windsurf, Gemini CLI):

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/absolute/path/to/unifi-mcp/dist/index.js"],
      "env": { "UNIFI_URL": "https://192.168.1.1", "UNIFI_API_KEY": "...", "UNIFI_CERT_SHA256": "..." }
    }
  }
}
```

VS Code (Copilot) uses a `servers` key in `.vscode/mcp.json`; Codex CLI uses `[mcp_servers.unifi]` in `~/.codex/config.toml` with the same `command`, `args` and `env`. Check your client's documentation for the exact file.

**The guidance travels with the server.** It sends `instructions` when a client connects, serves the longer guide (workflow, gotchas, recipes) as the resource `unifi://guide` and as the prompt `unifi_guide`, and describes every tool. A client that ignores instructions can still be told to read the guide. The Claude Code skill in `.claude/skills/unifi` is only a thin layer on top (spec upkeep, permissions).

**Safety does not depend on the client.** Allow/ask/deny rules by tool name are a Claude Code feature; other clients approve tools in their own way, and some approve everything. What always applies is the server's guard: every change is a dry run unless `dry_run=false` **and** `confirm=true`. For a client you do not trust to ask first, start the server with `UNIFI_READ_ONLY=1`.

## Permissions

Claude Code decides, per tool, whether a call runs, asks you, or is refused. `.claude/settings.json` in this repo allows the read tools and **asks** before `unifi_write`, `unifi_set_port_forward` and `unifi_delete`. To change that, edit the rules (or put them in `~/.claude/settings.json` to apply everywhere):

```json
{ "permissions": { "allow": ["mcp__unifi__unifi_write"], "deny": ["mcp__unifi__unifi_delete"] } }
```

Allowing `unifi_write` without asking leaves only the dry-run and `confirm=true` guard, which the model fills in itself, so keep it on `ask` unless you trust the session. For a server that can never change anything, start it with `-e UNIFI_READ_ONLY=1`.

## Development

`nvm use && npm ci && npm test` (100% coverage enforced; a fake gateway and a throwaway self-signed certificate, no real router). One ticket, one branch, one PR; Conventional Commits.

## Status

Tested in simulation (fake gateway, local TLS). Read tools, `unifi_search_api` and `unifi_call` (official and legacy) were exercised against a real UDM Pro (Network 11.0.99) on 2026-11-20. **A real write has been run once**: `unifi_write` with `legacy_update_port_forward` disabled and re-enabled the "Desk test" rule (dry run, apply, read back, revert), and the gateway moved the rule to the end of the list. Other write operations (create, delete, networks, firewall policies, Wi-Fi) have not been run against a real gateway; dry-run first and read the record back afterwards. The bundled specs match the gateway (Network 11.0.99, Protect 7.3.74); the gateway itself serves no spec.

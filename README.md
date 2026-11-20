# unifi-mcp

> **Unofficial.** Not affiliated with or endorsed by Ubiquiti Inc. UniFi and UniFi Protect are trademarks of Ubiquiti Inc. This server can change your network: changes are a dry run unless you confirm them, many write operations have not been tried on real gateways, and you use it at your own risk (MIT licence, no warranty). Report security problems as described in `SECURITY.md`.

A small [MCP](https://modelcontextprotocol.io) server for a UniFi gateway's **local** API (a UDM, UDM Pro, UCG and so on, Network 9+), written so that one person can read all of it. Nothing leaves your network.

## Install and sign in

Once published (not yet), run the setup once, in a terminal:

```sh
npx -y @mmoonport-labs/unifi-mcp setup
```

It asks for the **gateway address** (an IP or URL) and an **API key** (create one in UniFi: Settings > Control Plane > Integrations; typing is hidden). It then shows the gateway's certificate fingerprint, and you approve it once: the key is only ever sent to a gateway presenting that certificate. It checks that the key works before saving anything. The address and fingerprint go to `~/.config/unifi-mcp/config.json`; the key goes to the macOS Keychain or the Linux keyring (libsecret's `secret-tool`), or, where neither exists, to a file only you can read (`~/.config/unifi-mcp/key`, mode 600). `npx -y @mmoonport-labs/unifi-mcp logout` forgets all of it.

Then add the server to your MCP client with no environment variables, for Claude Code `claude mcp add unifi -- npx -y @mmoonport-labs/unifi-mcp`. Environment variables (below) still work and win over what setup saved, which suits CI and containers. A saved key and fingerprint are only used for the saved address.

Until it is published, build from source (`npm ci && npm run build`) and run `node dist/index.js setup`. Needs Node 24 or newer.

## Tools

| Tool | What it does |
|---|---|
| `unifi_info` | Network and Protect versions, sites, the loaded spec versions, and `specDrift` (apps whose spec differs from the gateway) |
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

The catalog is every operation of Ubiquiti's official Network and Protect integration APIs (about 70 each), plus a table of the legacy Network endpoints the official API does not cover. See "API specs" below for where the OpenAPI documents come from.

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
| `UNIFI_URL` | required unless `setup` saved one, e.g. `https://192.168.1.1` |
| `UNIFI_API_KEY` | required unless `setup` saved one. Create it in UniFi: Settings, Control Plane, Integrations. Only ever sent as the `X-API-KEY` header |
| `UNIFI_CERT_SHA256` | recommended: pin the gateway's own certificate (its SHA-256 fingerprint). The key is not sent to any other certificate |
| `UNIFI_INSECURE` | `1` to accept the self-signed certificate without pinning |
| `UNIFI_SITE` | site name, default `default` |
| `UNIFI_SPEC_FILE`, `UNIFI_PROTECT_SPEC_FILE` | path to another copy of the Network or Protect OpenAPI spec (a newer download or one corrected by hand), used instead of the fetched one |
| `UNIFI_SPEC_DIR` | where fetched specs are cached; default `$XDG_CACHE_HOME/unifi-mcp` or `~/.cache/unifi-mcp` |
| `UNIFI_SPEC_AUTO_UPDATE` | `0` to never fetch a spec (a closed network, or a spec you supply yourself) |
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

The server speaks standard MCP over stdio, so any client that can start a local server works. Run `setup` once (see Install), or give it `UNIFI_URL`, `UNIFI_API_KEY` and `UNIFI_CERT_SHA256` (see Configuration). The generic entry (with the environment shown, which you can leave out after `setup`), which most clients' JSON config takes under `mcpServers` (Claude Desktop, Cursor, Windsurf, Gemini CLI):

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

## API specs

Ubiquiti's OpenAPI documents are not part of this repository or package. At start-up the server asks the gateway for its Network and Protect versions and, if the cache has no spec for that version, downloads one: first from Ubiquiti's documentation CDN (`apidoc-cdn.ui.com`), then from the community repository [beezly/unifi-apis](https://github.com/beezly/unifi-apis), which extracts a spec from each release. If the gateway is newer than anything published, the nearest older release is used (unknown fields in a request then only warn). These downloads send nothing but the version number in the URL, and the files are only data, but they reach the model through the search and describe tools. With no spec at all the legacy operations still work and the official ones are missing; `unifi_info` says which spec is loaded. Set `UNIFI_SPEC_AUTO_UPDATE=0` to stop the downloads.

`npm test` needs real specs too, so a `pretest` step downloads pinned copies into `test/.specs` (not committed).

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

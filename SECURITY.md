# Security

This server can change a router, so treat its configuration as sensitive.

- **Report a vulnerability** privately through GitHub's "Report a vulnerability" button on the Security tab. Please do not open a public issue for one.
- `unifi-mcp setup` stores the key in the macOS Keychain or Linux keyring when there is one, else in a file readable only by you; it is never in `config.json`, a URL, a log line or an error. The key is read from `UNIFI_API_KEY` or that store, sent only in the `X-API-KEY` header, and never logged. Secret values in gateway replies are redacted.
- Pin the gateway's certificate with `UNIFI_CERT_SHA256` rather than disabling verification.
- Start with `UNIFI_READ_ONLY=1` when a client might approve tool calls without asking you.

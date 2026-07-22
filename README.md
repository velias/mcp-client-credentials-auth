# mcp-client-credentials-auth

[![CI](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/velias/f550f0ffe68a574a690032088359fef3/raw/mcp-client-credentials-auth-coverage.json)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/velias/mcp-client-credentials-auth/badge)](https://securityscorecards.dev/viewer/?uri=github.com/velias/mcp-client-credentials-auth)

A local stdio MCP server that authenticates to remote OAuth-protected MCP servers using the **client_credentials** grant ([MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials), [client secrets](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials#client-secrets) variant). Throughout this document, we refer to it as **the auth proxy**.

Drop it into any MCP client configuration for autonomous agents, background services, CI/CD, and other machine-to-machine use (no user in the loop). It acquires access tokens and forwards MCP traffic transparently. By default the token endpoint and scopes are auto-discovered via [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-05/basic/authorization) and RFC 9728 / RFC 8414. When discovery is unavailable, set a manual token endpoint; see [Servers without OAuth discovery](#servers-without-oauth-discovery).

To obtain `client_id` and `client_secret`, look for a "Service Account", "API Key", or "Machine-to-Machine Application" option in the remote MCP service's account or developer settings. Naming varies by provider; the service controls which scopes the credentials receive.

## How It Works

```
MCP Client ←→ [stdio] ←→ mcp-client-credentials-auth ←→ [HTTP/SSE + Bearer] ←→ Remote MCP Server
                                    ↓
                              IdP Token Endpoint
                          (client_credentials grant)
```

1. Resolves the IdP token endpoint and scopes via MCP Authorization discovery, or uses `MCP_CC_PROXY_TOKEN_ENDPOINT` / `MCP_CC_PROXY_SCOPES` when configured
2. Acquires tokens with OAuth `client_credentials`
3. Forwards all MCP methods bidirectionally with `Bearer` authentication
4. Refreshes tokens proactively and retries on 401

Also: Streamable HTTP with SSE fallback for transport failures only; fail-closed startup (stdio binds only after a usable token when auth is required and the remote is reachable); automatic reconnection and stale Streamable HTTP session recovery; capability polling; identity/capability forwarding; timeouts on all outgoing calls; generic pass-through (no hardcoded method tables). See [When the proxy starts or stays up](#when-the-proxy-starts-or-stays-up).

## Quick Start

```jsonc
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": ["-y", "mcp-client-credentials-auth"],
      "env": {
        "MCP_CC_PROXY_REMOTE_MCP_URL": "https://mcp.example.com/mcp",
        "MCP_CC_PROXY_CLIENT_ID": "my-service",
        "MCP_CC_PROXY_CLIENT_SECRET": "s3cr3t"
      }
    }
  }
}
```

Token endpoint and scopes are auto-discovered. If discovery is unavailable, set `MCP_CC_PROXY_TOKEN_ENDPOINT` (and usually `MCP_CC_PROXY_SCOPES`); see [Servers without OAuth discovery](#servers-without-oauth-discovery).

**Security note:** `npx` downloads and runs the package on your machine. Use trusted packages only.

## Configuration

All configuration via `MCP_CC_PROXY_*` environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_CC_PROXY_REMOTE_MCP_URL` | Yes | — | Remote MCP server URL (`http://` or `https://`) |
| `MCP_CC_PROXY_CLIENT_ID` | Yes | — | OAuth client_id |
| `MCP_CC_PROXY_CLIENT_SECRET` | Yes | — | OAuth client_secret |
| `MCP_CC_PROXY_TOKEN_ENDPOINT` | No | — | IdP token endpoint URL. When set, skips MCP Authorization discovery and posts tokens here. Prefer `https://`; cleartext HTTP to a non-loopback host logs a warning. See [Servers without OAuth discovery](#servers-without-oauth-discovery). |
| `MCP_CC_PROXY_SCOPES` | No | auto-discovered | Space-separated scopes for the token request. Overrides discovered `scopes_supported`. Required in practice with a manual token endpoint. See [Notes for MCP Server Developers](#notes-for-mcp-server-developers). |
| `MCP_CC_PROXY_DEBUG` | No | `false` | Enable debug logging to stderr |
| `MCP_CC_PROXY_REFRESH_SKEW_SECONDS` | No | `30` | Proactive token refresh window (seconds before expiry) |
| `MCP_CC_PROXY_REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for MCP requests, OAuth discovery, and token acquisition (ms) |
| `MCP_CC_PROXY_STARTUP_TIMEOUT_MS` | No | `60000` | Shared wall-clock budget for a usable access token (when auth is required) and a reachable remote MCP before exit |
| `MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS` | No | `60` | Interval to poll remote capability changes (0 = disabled) |

### Servers without OAuth discovery

Use when the remote MCP server accepts `Bearer` tokens but MCP Authorization discovery (RFC 9728 / RFC 8414) is not available. The proxy still uses `client_credentials`; configure the token endpoint and scopes from values provided by the MCP server provider (do not invent them). Prefer auto-discovery when available. If `MCP_CC_PROXY_TOKEN_ENDPOINT` is set, the manual path is used even when discovery would have worked.

**Required:** `MCP_CC_PROXY_REMOTE_MCP_URL`, `MCP_CC_PROXY_CLIENT_ID`, `MCP_CC_PROXY_CLIENT_SECRET`, `MCP_CC_PROXY_TOKEN_ENDPOINT`.

**Usually also:** `MCP_CC_PROXY_SCOPES` (no discovered `scopes_supported` in this mode).

Prefer `https://` for the token endpoint; cleartext HTTP to a non-loopback host logs a warning (client secret would travel unencrypted). Startup still requires a usable token and a reachable remote within `MCP_CC_PROXY_STARTUP_TIMEOUT_MS`.

```jsonc
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": ["-y", "mcp-client-credentials-auth"],
      "env": {
        "MCP_CC_PROXY_REMOTE_MCP_URL": "https://mcp.example.com/mcp",
        "MCP_CC_PROXY_CLIENT_ID": "my-service",
        "MCP_CC_PROXY_CLIENT_SECRET": "s3cr3t",
        "MCP_CC_PROXY_TOKEN_ENDPOINT": "https://auth.example.com/oauth/token",
        "MCP_CC_PROXY_SCOPES": "inventory.read orders.write"
      }
    }
  }
}
```

## Security

### Protecting Secrets with Vaults

The Quick Start example puts secrets directly in the MCP client config (typically plain text on disk). Prefer fetching them at launch from a vault or keychain.

#### 1Password CLI

Create a 1Password vault item (e.g. named "My MCP Credentials") with fields `client-id` and `client-secret`, then use [`op run`](https://developer.1password.com/docs/cli/reference/commands/run/) with a template file that contains `op://` references to those fields:

```ini
# ~/.config/mcp/my-server.env.tpl
MCP_CC_PROXY_REMOTE_MCP_URL=https://mcp.example.com/mcp
# op://<vault>/<item>/<field> - references to 1Password vault item fields
MCP_CC_PROXY_CLIENT_ID=op://Private/My MCP Credentials/client-id
MCP_CC_PROXY_CLIENT_SECRET=op://Private/My MCP Credentials/client-secret
```

```jsonc
{
  "mcpServers": {
    "my-remote-server": {
      "command": "op",
      "args": ["run", "--env-file=~/.config/mcp/my-server.env.tpl", "--", "npx", "-y", "mcp-client-credentials-auth"]
    }
  }
}
```

`op run` resolves the `op://` references at launch, injects the real values as environment variables, and executes the proxy. Secrets never touch the file system.

#### Bitwarden CLI

Create a Bitwarden vault login item (e.g. named "My MCP Credentials") and store the `client_id` as the username and `client_secret` as the password. Then use a wrapper script that fetches them via [`bw get`](https://bitwarden.com/help/cli/):

```bash
#!/usr/bin/env bash
export MCP_CC_PROXY_REMOTE_MCP_URL="https://mcp.example.com/mcp"
# "My MCP Credentials" is the name of the Bitwarden vault login item
export MCP_CC_PROXY_CLIENT_ID="$(bw get username 'My MCP Credentials')"
export MCP_CC_PROXY_CLIENT_SECRET="$(bw get password 'My MCP Credentials')"
exec npx -y mcp-client-credentials-auth
```

Save the script (e.g. `~/.local/bin/mcp-my-server.sh`), make it executable, and point your MCP config at it:

```jsonc
{
  "mcpServers": {
    "my-remote-server": {
      "command": "/Users/you/.local/bin/mcp-my-server.sh"
    }
  }
}
```

Bitwarden must be unlocked (`bw unlock`) before the MCP client starts the proxy.

#### macOS Keychain

Store the client secret in the built-in macOS Keychain. The `-s` flag is the service name (a label you choose to identify this entry), `-a` is the account name, and `-w` is the secret value:

```bash
security add-generic-password -s "My MCP Credentials" -a "client_secret" -w "my-client-secret"
```

Then use a wrapper script to read it at launch:

```bash
#!/usr/bin/env bash
export MCP_CC_PROXY_REMOTE_MCP_URL="https://mcp.example.com/mcp"
# The OAuth client ID assigned by your identity provider
export MCP_CC_PROXY_CLIENT_ID="my-oauth-client-id"
# -s and -a must match the values used in add-generic-password above
export MCP_CC_PROXY_CLIENT_SECRET="$(security find-generic-password -s 'My MCP Credentials' -a 'client_secret' -w)"
exec npx -y mcp-client-credentials-auth
```

No extra software required; the Keychain is built into macOS and protected by your login password or Touch ID.

### Runtime Credential Safeguards

- Access token is stored only in memory, never logged
- Client secrets loaded at startup, never forwarded or logged
- Authorization header always set by the auth proxy, never influenced by MCP client content
- Auth-like metadata keys (`authorization`, `token`, `bearer`, `access_token`, `client_secret`) stripped from `_meta` in all client-to-server messages before forwarding

## Troubleshooting

All auth proxy logs go to **stderr** (stdout is reserved for MCP protocol). To see them:

- **Cursor** - MCP server output panel (Developer: Show MCP Logs)
- **Claude Desktop** - `~/Library/Logs/Claude/mcp-server-*.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows)
- **Claude Code** - terminal with `--mcp-debug`

Set `MCP_CC_PROXY_DEBUG=true` for verbose OAuth discovery, forwarding, and refresh scheduling details.

Runtime failures use the same three categories in JSON-RPC errors and stderr (`category=`), prefixed with `mcp-client-credentials-auth`:

| Category | Meaning | Example |
|----------|---------|---------|
| `authentication` | Token/IdP failure (no usable token, scopes, client secret, OAuth discovery) | `mcp-client-credentials-auth [authentication]: no usable access token` |
| `connection` | Proxy cannot reach or stay connected to the remote MCP transport | `mcp-client-credentials-auth [connection]: temporarily unavailable (reconnecting)` |
| `remote` | Remote MCP server returned a protocol/application error (including resource-server 401/403) | `mcp-client-credentials-auth [remote]: …` |

Stderr lines also include `component=mcp-client-credentials-auth` so they remain attributable inside generic MCP client log panels.

### When the proxy starts or stays up

MCP clients typically treat a stdio server as healthy when the process is alive and `initialize` succeeds. They do not probe whether your IdP or remote MCP backend is working. This proxy **fail-closes at startup** and **self-heals at runtime**.

**Startup (process exits; your MCP client should show the server in error):**

| Situation | Behavior |
|-----------|----------|
| IdP unreachable, OAuth discovery fails, or other **transient** token prefetch failures within `MCP_CC_PROXY_STARTUP_TIMEOUT_MS` | Retries with backoff inside the shared startup budget, then exits. Check stderr for the real cause. |
| Permanent OAuth config rejection from the IdP (`invalid_scope`, `invalid_client`, `unauthorized_client`, etc.) | Immediate exit; no startup retries. Logged as **unrecoverable OAuth misconfiguration at the identity provider (IdP)** (the IdP rejected the token request, not the MCP server). Typical causes: wrong `MCP_CC_PROXY_SCOPES`, bad client id/secret, or grant not allowed for this client. Contact your MCP server provider. |
| Remote MCP server rejects the access token at startup (401/`Unauthorized`, `invalid_token`, `insufficient_scope`, etc.) | Immediate exit; logged as **unrecoverable OAuth misconfiguration at the remote MCP server** (token was issued, then rejected by the MCP server). Contact your MCP server provider to correct token validation, scopes/audience, or issued credentials. |
| Authorization server metadata does not advertise `client_credentials` (`unsupported-grant`) | Immediate exit; no startup retries. |
| Remote server needs no OAuth (`no-auth`) | Token not required; remote MCP must still be reachable within the startup budget or the process exits. |
| Remote MCP unreachable within the startup budget | Retries with backoff, then exits. Real remote capabilities are never invented; the local session is not opened. |

**Runtime (process stays up; the UI may stay green; requests fail until recovery):**

| Situation | Behavior |
|-----------|----------|
| Remote MCP disconnects | Requests get `connection` errors (e.g. `temporarily unavailable (reconnecting)`). Indefinite background reconnect with backoff; resumes when the remote is back. |
| Remote MCP restarted / Streamable HTTP session not found | Detects stale session (HTTP 404 or session-loss message), recreates the remote session, retries the request once; logs session lost and session reacquired on stderr. |
| Remote MCP (or PRM) required scopes change while the proxy is running | Not detected automatically; refresh keeps prior scopes. Restart the proxy (and update `MCP_CC_PROXY_SCOPES` if used). |
| Remote MCP Server or IdP discovery document changes while the proxy is running | Not detected automatically. Restart the proxy. |
| IdP down but a cached access token is still valid | Keeps serving until the token is no longer usable. |
| No usable access token and refresh/auth fails | Requests get a short `authentication` error (`no usable access token`). Indefinite background refresh/retry; resumes when a token is acquired again. |

**Client reconnect:** for stdio MCP, "reconnect" means the client respawns this process and runs a new `initialize`. The MCP spec says clients SHOULD restart an unexpectedly exited server; in practice Cursor and many UIs often need a manual toggle or Reload Window after a red startup failure. Mid-session problems show up on tool/resource calls, not necessarily as a red server dot.

### Token acquired but remote server returns 403

If the proxy acquires a token but the remote server rejects requests, the token likely has fewer scopes than expected. IdPs handle scopes in `client_credentials` differently:

- **Silent dropping** (Keycloak, Auth0): scopes not assigned to the client in the IdP are quietly removed from the token without an error. The proxy gets a valid token that lacks the permissions the MCP server requires. This is the hardest case to debug.
- **Strict rejection** (Okta, AWS Cognito): requesting a scope not assigned to the client fails the token request immediately with `invalid_scope`. At startup the proxy exits immediately and logs an **unrecoverable OAuth misconfiguration at the identity provider (IdP)** (no retries; cannot self-heal). Contact your MCP server provider to correct credentials, scopes, or IdP grants.
- **`.default` convention** (Entra ID / Azure AD): individual scope names are not accepted; you must use `{resource}/.default` via `MCP_CC_PROXY_SCOPES`. See [Entra ID (Azure AD) compatibility](#entra-id-azure-ad-compatibility). If permissions are still missing, the issue is often missing admin consent on the app registration.

**Debugging steps:**

1. Look for the startup scopes log: `OAuth discovery complete` (auto-discovery) or `Using manual token endpoint (skipping OAuth discovery)` (manual token endpoint). The `scopes` field shows what will be requested, or `(default)` / `(none)` if none were set.
2. Request a token directly from your IdP's token endpoint (using `curl` or your IdP's admin UI), decode it at [jwt.io](https://jwt.io) or with `jq`, and inspect the `scope` or `scp` claim to see what was actually granted.
3. Compare with the scopes the remote MCP server requires for the failing operation.
4. If scopes are missing, update the scope grants on your service account in the IdP, or contact the MCP server operator.

### OAuth discovery and scopes are fixed at startup

Protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), and the scopes used for `client_credentials` are resolved once at startup (or taken from `MCP_CC_PROXY_SCOPES` / a manual token endpoint). Proactive refresh reuses the same scopes; it does not re-fetch those descriptors.

If required scopes or IdP/PRM metadata change, restart the proxy (and update `MCP_CC_PROXY_SCOPES` if used). Some servers return `401`/`invalid_token` for missing scopes instead of `403`/`insufficient_scope`, so this proxy cannot reliably step up scopes in that case; see [Known Issues](#known-issues).

## Notes for MCP Server Developers

If you publish [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728), `scopes_supported` in `.well-known/oauth-protected-resource` is consumed by both interactive clients (authorization code) and machine-to-machine clients (`client_credentials`). Those flows can need different IdP scope formats. When a `client_credentials` override is required, document the correct `MCP_CC_PROXY_SCOPES` value in your setup instructions.

### Recommended approach

List **granular, application-level scopes** in `scopes_supported` (works for interactive clients and most IdPs):

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["inventory.read", "orders.write", "orders.read"]
}
```

List every scope your server uses so clients can request the full set on initial token acquisition and avoid per-operation 403 challenges (see [Known Issues](#known-issues)). Machine-to-machine clients whose IdP needs a different format override via `MCP_CC_PROXY_SCOPES` without changing server metadata.

### Entra ID (Azure AD) compatibility

Entra ID requires `{resource}/.default` for `client_credentials` and rejects individual scope names. `scopes_supported` cannot usefully hold both granular scopes (authorization code) and `.default` (`client_credentials`), so the override is the intended solution:

```jsonc
// MCP client config for Entra ID
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": ["-y", "mcp-client-credentials-auth"],
      "env": {
        "MCP_CC_PROXY_REMOTE_MCP_URL": "https://mcp.example.com/mcp",
        "MCP_CC_PROXY_CLIENT_ID": "my-service",
        "MCP_CC_PROXY_CLIENT_SECRET": "s3cr3t",
        "MCP_CC_PROXY_SCOPES": "api://my-api-client-id/.default"
      }
    }
  }
}
```

## Identity and Capabilities Forwarding

During `initialize`, the auth proxy forwards identity and capabilities in both directions with a two-phase remote connection:

1. **Discovery** - connect to the remote to learn its identity/capabilities, then disconnect
2. **Local handshake** - present the remote server's identity to your MCP client
3. **Reconnect** - reconnect to the remote with your client's real identity (plus a suffix) and capabilities

Your MCP client sees the remote server's real name. The remote sees a name like `cursor-vscode via mcp-client-credentials-auth v0.1.0` with the client's version. Local capabilities (`sampling`, `roots`, `elicitation`, etc.) are forwarded so server-to-client features work through the proxy.

The proxy also declares the [`io.modelcontextprotocol/oauth-client-credentials`](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) extension on both connections so the remote can apply machine-to-machine policies.

## Known Issues

### Scope step-up and the MCP TypeScript SDK

The MCP TypeScript SDK has known bugs around scope step-up (403 `insufficient_scope` handling):

1. **Scope overwrite instead of accumulation** ([typescript-sdk#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)): when multiple operations require different scopes, the transport overwrites the active scope instead of merging, causing infinite re-authorization loops.
2. **`fetchToken` ignores challenge scope** ([typescript-sdk#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)): for `client_credentials`, `fetchToken()` uses `clientMetadata.scope` instead of the `WWW-Authenticate` challenge scope, so new scopes never reach the token endpoint.

**This proxy works around both for Streamable HTTP:** on `403` with `WWW-Authenticate` `error="insufficient_scope"` and a `scope` parameter, it merges the challenge into its running scope set, acquires a new token with the full union, retries once, and logs on stderr (`Scope step-up challenge received…` / `Scope step-up token acquired`). Later calls that need more scopes expand the same set (when the IdP grants them). If the IdP rejects the stepped-up scopes, the proxy keeps the previous scopes and access token, returns the original `403`, and stays usable for other requests.

Prefer listing every scope in `scopes_supported` / `MCP_CC_PROXY_SCOPES` so step-up is unnecessary.

**Not covered:** some servers (including some FastMCP paths) return `401` + `invalid_token` for missing scopes instead of `403` + `insufficient_scope`. That cannot be stepped up reliably; restart the proxy after required-scope policy changes. See [OAuth discovery and scopes are fixed at startup](#oauth-discovery-and-scopes-are-fixed-at-startup).

When both upstream issues are fixed in a released SDK, remove the workaround (see the MCP SDK upgrade checklist in [AGENTS.md](AGENTS.md)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines. See [AGENTS.md](AGENTS.md) for architecture and code conventions.

## License

[Apache License 2.0](LICENSE)

# mcp-client-credentials-auth

[![CI](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/velias/f550f0ffe68a574a690032088359fef3/raw/mcp-client-credentials-auth-coverage.json)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/velias/mcp-client-credentials-auth/badge)](https://securityscorecards.dev/viewer/?uri=github.com/velias/mcp-client-credentials-auth)

A local stdio MCP server that authenticates to remote OAuth-protected MCP servers using the **client_credentials** grant, as defined in the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials). Throughout this document, we refer to it as **the auth proxy**.

Drop it into any MCP client configuration and it transparently handles access token acquisition and MCP request forwarding. By default the token endpoint and scopes are auto-discovered via [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-05/basic/authorization) and RFC 9728 / RFC 8414. When the remote server accepts Bearer tokens but that discovery is not available, you can supply the IdP token endpoint directly instead (see [Servers without OAuth discovery](#servers-without-oauth-discovery)).

This implements the [client secrets](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials#client-secrets) variant of the MCP OAuth Client Credentials extension, designed for autonomous AI agents, background services, CI/CD pipelines, server-to-server integrations, and daemon processes that need MCP access without the user in the loop.

To obtain the required `client_id` and `client_secret`, look for a "Service Account", "API Key", or "Machine-to-Machine Application" option in the account management or developer settings UI provided by the remote MCP service or platform. Most services let end users create these credentials self-service, the exact location and naming varies by provider. The service also controls which scopes and permissions the credentials are granted.

## Features

- **Zero-config OAuth** - token endpoint and scopes auto-discovered via MCP Authorization and RFC 9728 / RFC 8414
- **Manual token endpoint** - optional override when the remote MCP server accepts Bearer tokens but MCP Authorization discovery (RFC 9728 / RFC 8414) is not available
- **Transparent forwarding** - all MCP methods forwarded bidirectionally (tools, resources, prompts, sampling, notifications)
- **Proactive token refresh** - tokens refreshed before expiry using `refreshSkewSeconds` (default 30s) with automatic retries, no MCP request latency spikes
- **Transport fallback** - Streamable HTTP with automatic SSE fallback for transport failures only (not authentication errors; both transports share the same IdP credentials)
- **Resilient startup** - starts even when the remote MCP server or IdP is unavailable, connecting automatically when they become reachable
- **Automatic reconnection** - detects remote server disconnects and reconnects with exponential backoff, preserving client identity and capabilities
- **Live change detection** - polls the remote server for capability changes (tools, resources, prompts) and notifies your MCP client automatically
- **Identity forwarding** - remote server name and capabilities forwarded to your MCP client, your client's real identity and capabilities forwarded to the remote MCP server
- **Timeouts on all network calls** - all outgoing connections (MCP requests, OAuth discovery, token acquisition) enforce `requestTimeoutMs` to prevent hangs
- **Forward-compatible** - generic pass-through design (no hardcoded method tables) means new MCP spec versions should work by bumping the SDK dependency only

## How It Works

```
MCP Client ←→ [stdio] ←→ mcp-client-credentials-auth ←→ [HTTP/SSE + Bearer] ←→ Remote MCP Server
                                    ↓
                              IdP Token Endpoint
                          (client_credentials grant)
```

The auth proxy sits between your MCP client and the remote MCP server:
1. Resolves the IdP token endpoint and scopes via MCP Authorization and RFC 9728 / RFC 8414, or uses `MCP_CC_PROXY_TOKEN_ENDPOINT` (and optional `MCP_CC_PROXY_SCOPES`) when that discovery is not available; see [Servers without OAuth discovery](#servers-without-oauth-discovery)
2. Acquires tokens using OAuth `client_credentials` grant
3. Forwards all MCP requests/responses with `Bearer` authentication
4. Handles token refresh and 401 retry transparently

If the IdP is temporarily unavailable at startup, the auth proxy will periodically retry with exponential backoff (5s to 60s): OAuth rediscovery in the auto-discovery path, or token prefetch retries when using a manual token endpoint. It begins serving authenticated requests as soon as a token can be acquired. If the remote MCP server is unreachable at startup, the auth proxy will still start and accept connections from your MCP client, advertising default capabilities (tools, resources, prompts). It will automatically connect to the remote server when it becomes available.

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

That's it. Token endpoint, auth method, and scopes are auto-discovered via MCP Authorization and RFC 9728 / RFC 8414. If that discovery is not available, set `MCP_CC_PROXY_TOKEN_ENDPOINT` (and usually `MCP_CC_PROXY_SCOPES`); see [Servers without OAuth discovery](#servers-without-oauth-discovery).

**Security note:** `npx` command downloads npm package and runs it on your local machine. Use it with trusted packages only!

## Configuration

All configuration via `MCP_CC_PROXY_*` environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_CC_PROXY_REMOTE_MCP_URL` | Yes | — | Remote MCP server URL (`http://` or `https://`) |
| `MCP_CC_PROXY_CLIENT_ID` | Yes | — | OAuth client_id |
| `MCP_CC_PROXY_CLIENT_SECRET` | Yes | — | OAuth client_secret |
| `MCP_CC_PROXY_TOKEN_ENDPOINT` | No | — | IdP token endpoint URL (`http://` or `https://`). When set, skips MCP Authorization discovery (RFC 9728 / RFC 8414) and requests tokens directly from this URL. Use `https://` in production; cleartext HTTP to a non-loopback host logs a warning because the client secret would travel unencrypted. See [Servers without OAuth discovery](#servers-without-oauth-discovery). |
| `MCP_CC_PROXY_SCOPES` | No | auto-discovered | OAuth scopes sent in the token request (space-separated). When set, `scopes_supported` from MCP Authorization / RFC 9728 discovery is ignored. With a manual token endpoint that discovery is skipped, so set this if your MCP Server requires scopes. See [Notes for MCP Server Developers](#notes-for-mcp-server-developers). |
| `MCP_CC_PROXY_DEBUG` | No | `false` | Enable debug logging to stderr |
| `MCP_CC_PROXY_REFRESH_SKEW_SECONDS` | No | `30` | Proactive token refresh window (seconds before token expiry) |
| `MCP_CC_PROXY_REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for all outgoing network calls: MCP requests, OAuth discovery, and token acquisition (ms) |
| `MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS` | No | `60` | Interval to poll remote MCP server for capability changes (0 = disabled) |

### Servers without OAuth discovery

Use this when the remote MCP server accepts `Bearer` tokens but MCP Authorization discovery (RFC 9728 / RFC 8414) is not available. The proxy still uses the OAuth `client_credentials` grant; instead of discovering the token endpoint and scopes, you configure them from values provided by the MCP server provider (their setup docs, developer portal, or support). Do not invent these values; the provider knows the correct IdP token endpoint URL and which scopes your credentials need.

**Required:** `MCP_CC_PROXY_REMOTE_MCP_URL`, `MCP_CC_PROXY_CLIENT_ID`, `MCP_CC_PROXY_CLIENT_SECRET`, `MCP_CC_PROXY_TOKEN_ENDPOINT`.

**Usually also:** `MCP_CC_PROXY_SCOPES` (there is no discovered `scopes_supported` in this mode; use the scopes your provider documents).

Prefer `https://` for `MCP_CC_PROXY_TOKEN_ENDPOINT`; cleartext HTTP to a non-loopback host logs a warning because the client secret would travel unencrypted.

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

What changes versus auto-discovery via MCP Authorization and RFC 9728 / RFC 8414:

- Skips that discovery and uses your configured token endpoint instead
- Still acquires tokens with `client_credentials`, attaches `Bearer` on MCP requests, and runs proactive refresh
- If the IdP is down at startup, the proxy still starts and retries token acquisition in the background (5s to 60s backoff) until it succeeds

Prefer auto-discovery via MCP Authorization and RFC 9728 / RFC 8414 when it is available. If you set `MCP_CC_PROXY_TOKEN_ENDPOINT`, the manual path is used even when discovery would have worked.

## Security

### Protecting Secrets with Vaults

The Quick Start example puts secrets directly in the MCP client config. These are typically stored on disc as plain text. For better security, fetch them at launch time from a vault or keychain.

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
- Auth-like metadata keys (`authorization`, `token`, `bearer`, `access_token`, `client_secret`) stripped from `_meta` in all client-to-server messages (requests and notifications) before forwarding to prevent any influence by MCP Client

## Troubleshooting

All auth proxy logs are written to **stderr** (stdout is reserved for MCP protocol messages). To see them:

- **Cursor** - open the MCP server output panel (Developer: Show MCP Logs)
- **Claude Desktop** - check `~/Library/Logs/Claude/mcp-server-*.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows)
- **Claude Code** - logs appear in the terminal with `--mcp-debug` flag

Set `MCP_CC_PROXY_DEBUG=true` for verbose output including OAuth discovery details, message forwarding, and token refresh scheduling.

Every runtime failure is labeled with the same three categories in both JSON-RPC errors and stderr (`category=`), always prefixed with `mcp-client-credentials-auth`:

| Category | Meaning | Example |
|----------|---------|---------|
| `authentication` | Token/IdP failure (scopes, client secret, OAuth discovery) | `mcp-client-credentials-auth [authentication]: Invalid scopes: api.graphql` |
| `connection` | Proxy cannot reach or stay connected to the remote MCP transport | `mcp-client-credentials-auth [connection]: temporarily unavailable (reconnecting)` |
| `remote` | Remote MCP server returned a protocol/application error (including resource-server 401/403) | `mcp-client-credentials-auth [remote]: …` |

Stderr lines also include `component=mcp-client-credentials-auth` so they remain attributable inside generic MCP client log panels.

### Token acquired but remote server returns 403

If the proxy acquires a token but the remote server rejects requests, the token likely has fewer scopes than expected. IdPs handle scopes in `client_credentials` differently:

- **Silent dropping** (Keycloak, Auth0): scopes not assigned to the client in the IdP are quietly removed from the token without an error. The proxy gets a valid token that lacks the permissions the MCP server requires. This is the hardest case to debug.
- **Strict rejection** (Okta, AWS Cognito): requesting a scope not assigned to the client fails the token request immediately with `invalid_scope`. Easier to diagnose since the proxy logs `Token prefetch failed (will retry on first request)` at startup.
- **`.default` convention** (Entra ID / Azure AD): individual scope names are not accepted; you must use `{resource}/.default`. Set `MCP_CC_PROXY_SCOPES` to override with the `.default` format; check the remote MCP server's documentation for the exact value. If permissions are still missing, the issue is likely missing admin consent on the app registration; contact the MCP server operator or your Azure AD tenant administrator.

**Debugging steps:**

1. Look for the startup scopes log: `OAuth discovery complete` (auto-discovery) or `Using manual token endpoint (skipping OAuth discovery)` (manual token endpoint). The `scopes` field shows what will be requested, or `(default)` / `(none)` if none were set.
2. Request a token directly from your IdP's token endpoint (using `curl` or your IdP's admin UI), decode it at [jwt.io](https://jwt.io) or with `jq`, and inspect the `scope` or `scp` claim to see what was actually granted.
3. Compare with the scopes the remote MCP server requires for the failing operation.
4. If scopes are missing, update the scope grants on your service account in the IdP, or contact the MCP server operator.

## Notes for MCP Server Developers

If you operate an MCP server that publishes [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728), the `scopes_supported` field in your `.well-known/oauth-protected-resource` document is consumed by both interactive clients (authorization code flow) and machine-to-machine clients (client_credentials flow). These two flows can have conflicting scope requirements depending on the IdP. If your setup requires a scope override for `client_credentials`, document the correct `MCP_CC_PROXY_SCOPES` value in your user-facing setup instructions.

### Recommended approach

List **granular, application-level scopes** in `scopes_supported`. These serve the common case (interactive clients) and work with most IdPs:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["inventory.read", "orders.write", "orders.read"]
}
```

Machine-to-machine clients whose IdP requires a different scope format can override via `MCP_CC_PROXY_SCOPES` (or equivalent in their tooling) without requiring changes to the server's metadata.

### Entra ID (Azure AD) compatibility

Entra ID requires `{resource}/.default` for `client_credentials` grants and rejects individual scope names. Since `scopes_supported` cannot contain both granular scopes (for authorization code flow) and `.default` (for `client_credentials` flow) in a way that works for both, the override is the intended solution:

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

### Announce all required scopes

List every scope your server uses in `scopes_supported`. The auth proxy (and the MCP SDK in general) requests the full set on initial token acquisition, which avoids per-operation 403 challenges. This is especially important because the MCP TypeScript SDK has [known scope step-up bugs](#scope-step-up-does-not-work-reliably-with-client_credentials) that can cause infinite re-authorization loops when scopes are added incrementally.

## Identity and Capabilities Forwarding

The MCP protocol exchanges identity (`name`, `version`) and capabilities during the `initialize` handshake. The auth proxy forwards both in each direction using a two-phase connection strategy:

1. **Discovery phase**: the auth proxy connects to the remote server to learn its identity and capabilities, then disconnects.
2. **Local handshake**: the auth proxy presents the remote server's identity to your MCP client.
3. **Reconnect phase**: after your MCP client identifies itself, the auth proxy reconnects to the remote server with the real client identity (plus a suffix) and the real client capabilities.

**Remote server identity → local client:** Your MCP client sees the real remote server name in its UI, not the auth proxy.

**Local client identity → remote server:** The auth proxy automatically forwards your MCP client's name with a suffix indicating its name and version. For example, if Cursor (`cursor-vscode` v1.0.0) connects through the auth proxy v0.1.0, the remote server sees:

- `clientInfo.name`: `"cursor-vscode via mcp-client-credentials-auth v0.1.0"`
- `clientInfo.version`: `"1.0.0"`

No configuration is needed; the real client name is introspected from the MCP handshake.

**Client capabilities → remote server:** The auth proxy forwards the local client's declared capabilities (`sampling`, `roots`, `elicitation`, etc.) to the remote server. This enables server-to-client features like sampling requests and root listing to work through the auth proxy.

**Extension announcement:** The auth proxy automatically declares the [`io.modelcontextprotocol/oauth-client-credentials`](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) extension in its client capabilities when connecting to the remote server. This signals to the remote server that the connecting client authenticates via the client credentials flow, allowing the server to adjust behavior accordingly (e.g., skip interactive auth prompts, apply machine-to-machine policies). The extension is declared on both the discovery connection and the real connection.

## Known Issues

### Scope step-up does not work reliably with `client_credentials`

The MCP TypeScript SDK has known bugs around scope step-up (403 `insufficient_scope` handling):

1. **Scope overwrite instead of accumulation** ([typescript-sdk#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)): when multiple operations require different scopes, the transport overwrites the active scope instead of merging, causing infinite re-authorization loops.
2. **`fetchToken` ignores challenge scope** ([typescript-sdk#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)): for `client_credentials` grants, `fetchToken()` reads the scope from the provider's immutable `clientMetadata.scope` rather than the scope extracted from the `WWW-Authenticate` header. A 403 challenge with a new scope never actually reaches the token endpoint.

These are upstream SDK issues with open PRs, but no released fix as of SDK v1.x.

**Workaround:** List all scopes your server uses in `scopes_supported` so the full set is requested on initial token acquisition and no per-operation 403 challenges occur. See [Announce all required scopes](#announce-all-required-scopes) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines. See [AGENTS.md](AGENTS.md) for architecture and code conventions.

## License

[Apache License 2.0](LICENSE)

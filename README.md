# mcp-client-credentials-auth

A local stdio MCP server that authenticates to remote OAuth-protected MCP servers using the **client_credentials** grant, as defined in the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials).

Drop it into any MCP client configuration and it transparently handles [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-05/basic/authorization)-based OAuth discovery of the remote MCP Server and its announced Authorization server (IdP), token acquisition, proactive refresh, and request forwarding. Throughout this document, we refer to it as **the auth proxy**.

This implements the [client secrets](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials#client-secrets) variant of the MCP OAuth Client Credentials extension, designed for autonomous AI agents, background services, CI/CD pipelines, server-to-server integrations, and daemon processes that need MCP access without the user in the loop.

To obtain the required `client_id` and `client_secret`, look for a "Service Account", "API Key", or "Machine-to-Machine Application" option in the account management or developer settings UI provided by the remote MCP service or platform. Most services let end users create these credentials self-service; the exact location and naming varies by provider. The service controls which scopes and permissions the credentials are granted.

## Features

- **Zero-config OAuth** - token endpoint and scopes auto-discovered via MCP Authorization and RFC 9728 / RFC 8414
- **Transparent forwarding** - all MCP methods forwarded bidirectionally (tools, resources, prompts, sampling, notifications)
- **Proactive token refresh** - tokens refreshed before expiry using `refreshSkewSeconds` (default 30s) with automatic retries, no request latency spikes
- **Transport fallback** - Streamable HTTP with automatic SSE fallback
- **Automatic reconnection** - detects remote server disconnects and reconnects with exponential backoff, preserving client identity and capabilities
- **Live change detection** - polls the remote server for capability changes (tools, resources, prompts) and notifies your MCP client automatically
- **Identity forwarding** - remote server name and capabilities forwarded to your MCP client; your client's real identity and capabilities forwarded to the remote MCP server
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
1. Discovers OAuth metadata from the remote MCP server via RFC 9728 protected resource metadata
2. Resolves the authorization server (uses the first entry from the `authorization_servers` array in the resource metadata)
3. Acquires tokens using OAuth `client_credentials` grant
4. Forwards all MCP requests/responses with `Bearer` authentication
5. Handles token refresh and 401 retry transparently

If the IdP is temporarily unavailable at startup, the auth proxy will periodically retry OAuth discovery with exponential backoff (5s to 60s) and begin serving requests as soon as discovery succeeds.

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

That's it. Token endpoint, auth method, and scopes are all auto-discovered.

## Configuration

All configuration via `MCP_CC_PROXY_*` environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_CC_PROXY_REMOTE_MCP_URL` | Yes | — | Remote MCP server URL (`http://` or `https://`; use `https://` for production) |
| `MCP_CC_PROXY_CLIENT_ID` | Yes | — | OAuth client_id |
| `MCP_CC_PROXY_CLIENT_SECRET` | Yes | — | OAuth client_secret |
| `MCP_CC_PROXY_REFRESH_SKEW_SECONDS` | No | `30` | Proactive refresh window (seconds before token expiry) |
| `MCP_CC_PROXY_REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for all outgoing network calls: MCP requests, OAuth discovery, and token acquisition (ms) |
| `MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS` | No | `60` | Interval to poll remote for capability changes (0 = disabled) |
| `MCP_CC_PROXY_DEBUG` | No | `false` | Enable debug logging to stderr |

### Using with `.env` files

Use Node.js `--env-file` flag or your MCP client's `env` configuration block.

### Troubleshooting

All auth proxy logs are written to **stderr** (stdout is reserved for MCP protocol messages). To see them:

- **Cursor** - open the MCP server output panel (Developer: Show MCP Logs)
- **Claude Desktop** - check `~/Library/Logs/Claude/mcp-server-*.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows)
- **Claude Code** - logs appear in the terminal with `--mcp-debug` flag

Set `MCP_CC_PROXY_DEBUG=true` for verbose output including OAuth discovery details, message forwarding, and token refresh scheduling.

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

## Security

### Transport Security
- Always use `https://` for production remote MCP server URLs to protect the access token on the wire
- TLS certificates validated by default (Node.js `fetch`)
- `http://` is allowed for local development (`localhost`, `127.0.0.1`, `[::1]`) but logs a security warning for non-loopback hosts
- Warning logged if `NODE_TLS_REJECT_UNAUTHORIZED=0` is detected

### Credential Protection
- Authorization header always set by the auth proxy, never influenced by MCP client content
- Auth-like metadata keys (`authorization`, `token`, `bearer`, `access_token`, `client_secret`) stripped from `_meta` in all client-to-server messages (requests and notifications) before forwarding
- Access tokens stored only in memory, never logged
- Client secrets loaded at startup, never forwarded or logged
- All log output redacts token/secret values

### Process Environment
- `MCP_CC_PROXY_CLIENT_SECRET` is visible in `/proc/<pid>/environ` to the same OS user
- This matches the security boundary of the MCP client itself (same user, same machine)

### Scopes
- The auth proxy requests all scopes from `scopes_supported` in the resource metadata on initial token acquisition
- Scope grants are bounded by IdP client configuration (IdP is the ceiling)
- Configure your IdP client with minimal necessary scopes (least privilege)

## Known Issues

### Scope step-up does not work reliably with `client_credentials`

The MCP TypeScript SDK has known bugs around scope step-up (403 `insufficient_scope` handling):

1. **Scope overwrite instead of accumulation** ([typescript-sdk#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)): when multiple operations require different scopes, the transport overwrites the active scope instead of merging, causing infinite re-authorization loops.
2. **`fetchToken` ignores challenge scope** ([typescript-sdk#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)): for `client_credentials` grants, `fetchToken()` reads the scope from the provider's immutable `clientMetadata.scope` rather than the scope extracted from the `WWW-Authenticate` header. A 403 challenge with a new scope never actually reaches the token endpoint.

These are upstream SDK issues with open PRs, but no released fix as of SDK v1.x.

**Workaround:** Announce **all scopes your server uses** in the `scopes_supported` field of your [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) document (`.well-known/oauth-protected-resource`). The auth proxy requests the full set from `scopes_supported` on the initial token acquisition, so every operation will succeed without needing step-up:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["mcp:tools:read", "mcp:tools:write", "mcp:resources:read"]
}
```

As long as all required scopes are listed in `scopes_supported` and your IdP grants them to the client, no per-operation 403 challenges will occur and the bug is never triggered.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines. See [AGENTS.md](AGENTS.md) for architecture and code conventions.

## License

[Apache License 2.0](LICENSE)

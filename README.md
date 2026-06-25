# mcp-client-credentials-auth

A local stdio MCP server that authenticates to remote OAuth-protected MCP servers using the **client_credentials** grant, as defined in the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials). Drop it into any MCP client configuration and it transparently handles [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-05/basic/authorization)-based OAuth discovery of the remote MCP Server and its announced Authorization server (IdP), token acquisition, proactive refresh, and request proxying.

This implements the [client secrets](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials#client-secrets) variant of the MCP OAuth Client Credentials extension - designed for autonomous AI agents, background services, CI/CD pipelines, server-to-server integrations, and daemon processes that need MCP access without the user in the loop.

To obtain the required `client_id` and `client_secret`, look for a "Service Account", "API Key", or "Machine-to-Machine Application" option in the account management or developer settings UI provided by the remote MCP service or platform. Most services let end users create these credentials self-service - the exact location and naming varies by provider. The service controls which scopes and permissions the credentials are granted.

## Features

- **Zero-config OAuth** - token endpoint and scopes auto-discovered via MCP Authorization and RFC 9728 / RFC 8414
- **Transparent proxy** - all MCP methods forwarded bidirectionally (tools, resources, prompts, sampling, notifications)
- **Proactive token refresh** - tokens refreshed before expiry, no request latency spikes
- **In-flight de-duplication** - concurrent MCP requests share a single token acquisition
- **Scope step-up** - handles `WWW-Authenticate` challenges for additional scopes (see [known issues](#known-issues) for current SDK limitations)
- **Transport fallback** - Streamable HTTP with automatic SSE fallback
- **Live change detection** - polls the remote server for capability changes (tools, resources, prompts) and notifies your MCP client automatically, even after server restarts
- **Identity forwarding** - remote server name and capabilities forwarded to your MCP client; your client's real identity and capabilities forwarded to the remote server
- **Forward-compatible** - generic pass-through design (no hardcoded method tables) means new MCP spec versions should work by bumping the SDK dependency only

## How It Works

```
MCP Client ←→ [stdio] ←→ mcp-client-credentials-auth ←→ [HTTP/SSE + Bearer] ←→ Remote MCP Server
                                    ↓
                              IdP Token Endpoint
                          (client_credentials grant)
```

The proxy sits between your MCP client and the remote MCP server:
1. Discovers OAuth metadata from the remote MCP server via RFC 9728 protected resource metadata
2. Resolves the authorization server (uses the first entry from the `authorization_servers` array in the resource metadata)
3. Acquires tokens using OAuth `client_credentials` grant
4. Forwards all MCP requests/responses with `Bearer` authentication
5. Handles token refresh and 401 retry transparently

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
| `MCP_CC_PROXY_REMOTE_MCP_URL` | Yes | — | Remote MCP server URL |
| `MCP_CC_PROXY_CLIENT_ID` | Yes | — | OAuth client_id |
| `MCP_CC_PROXY_CLIENT_SECRET` | Yes | — | OAuth client_secret |
| `MCP_CC_PROXY_REFRESH_SKEW_SECONDS` | No | `30` | Proactive refresh window (seconds before token expiry ) |
| `MCP_CC_PROXY_REQUEST_TIMEOUT_MS` | No | `30000` | Upstream request timeout (ms) |
| `MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS` | No | `60` | Interval to poll remote for capability changes (0 = disabled) |
| `MCP_CC_PROXY_DEBUG` | No | `false` | Enable debug logging to stderr |

### Using with `.env` files

Use Node.js `--env-file` flag or your MCP client's `env` configuration block.

## Identity and Capabilities Forwarding

The MCP protocol exchanges identity (`name`, `version`) and capabilities during the `initialize` handshake. The proxy forwards both in each direction using a two-phase connection strategy:

1. **Discovery phase**: the proxy connects to the remote server to learn its identity and capabilities, then disconnects.
2. **Local handshake**: the proxy presents the remote server's identity to your MCP client.
3. **Reconnect phase**: after your MCP client identifies itself, the proxy reconnects to the remote server with the real client identity (plus a proxy suffix) and the real client capabilities.

**Remote server identity → local client:** Your MCP client sees the real remote server name in its UI, not the proxy.

**Local client identity → remote server:** The proxy automatically forwards your MCP client's name with a suffix indicating the proxy name and version. For example, if Cursor (`cursor-vscode` v1.0.0) connects through proxy v0.1.0, the remote server sees:

- `clientInfo.name`: `"cursor-vscode via mcp-client-credentials-auth v0.1.0"`
- `clientInfo.version`: `"1.0.0"`

No configuration is needed; the real client name is introspected from the MCP handshake.

**Client capabilities → remote server:** The proxy forwards the local client's declared capabilities (`sampling`, `roots`, `elicitation`, etc.) to the remote server. This enables server-to-client features like sampling requests and root listing to work through the proxy.

## URL Best Practices

- **Always use `https://`** for production remote MCP server URLs to protect access token on the wire
- `http://` is allowed but logs a security warning for non-loopback hosts
- Tokens and client credentials travel in HTTP headers; cleartext HTTP exposes them to network observers
- For local development, `http://localhost:*` and `http://127.0.0.1:*` are safe

## Security

### Transport Security
- TLS certificates validated by default (Node.js `fetch`)
- Warning logged if `NODE_TLS_REJECT_UNAUTHORIZED=0` is detected
- Warning logged if remote URL uses `http://` to non-loopback host

### Credential Protection
- Authorization header always set by proxy, never influenced by MCP client content
- Access tokens stored only in memory, never logged
- Client secrets loaded at startup, never forwarded or logged
- All log output redacts token/secret values

### Process Environment
- `MCP_CC_PROXY_CLIENT_SECRET` is visible in `/proc/<pid>/environ` to the same OS user
- This matches the security boundary of the MCP client itself (same user, same machine)

### Scope Security
- Scope step-up bounded by IdP client configuration (IdP is the ceiling)
- Step-up events logged at warn level
- Configure your IdP client with minimal necessary scopes (least privilege)

## Known Issues

### Scope step-up does not work reliably with `client_credentials`

The MCP TypeScript SDK has known bugs around scope step-up (403 `insufficient_scope` handling):

1. **Scope overwrite instead of accumulation** ([typescript-sdk#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)): when multiple operations require different scopes, the transport overwrites the active scope instead of merging, causing infinite re-authorization loops.
2. **`fetchToken` ignores challenge scope** ([typescript-sdk#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)): for `client_credentials` grants, `fetchToken()` reads the scope from the provider's immutable `clientMetadata.scope` rather than the scope extracted from the `WWW-Authenticate` header. A 403 challenge with a new scope never actually reaches the token endpoint.

These are upstream SDK issues with open PRs, but no released fix as of SDK v1.x.

**How to avoid this on the MCP server side:** Announce **all scopes your server uses** in the `scopes_supported` field of your [RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) document (`.well-known/oauth-protected-resource`). The proxy requests the full set from `scopes_supported` on the initial token acquisition, so every operation will succeed without needing step-up:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["mcp:tools:read", "mcp:tools:write", "mcp:resources:read"]
}
```

As long as all required scopes are listed in `scopes_supported` and your IdP grants them to the client, no per-operation 403 challenges will occur and the bug is never triggered.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Run tests with coverage report
npm run test:coverage

# Lint
npm run lint

# Build
npm run build
```

Coverage reports are generated in `coverage/` (text summary printed to terminal, plus `lcov` and `json-summary` for CI integration). The report covers all `src/` files except the entry point (`src/index.ts`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, and [AGENTS.md](AGENTS.md) for architecture and code conventions.

## License

[Apache License 2.0](LICENSE)

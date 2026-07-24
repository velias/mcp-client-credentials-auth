# mcp-client-credentials-auth

[![CI](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/velias/f550f0ffe68a574a690032088359fef3/raw/mcp-client-credentials-auth-coverage.json)](https://github.com/velias/mcp-client-credentials-auth/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/velias/mcp-client-credentials-auth/badge)](https://securityscorecards.dev/viewer/?uri=github.com/velias/mcp-client-credentials-auth)

This app acts as an MCP server that authenticates to remote OAuth-protected MCP servers using the **client_credentials** grant ([MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials), [client secrets](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials#client-secrets) variant). Throughout this document, we refer to it as **the auth proxy**.

Drop it into any MCP client configuration for autonomous agents, background services, CI/CD, and other machine-to-machine use (no user in the loop). It acquires access tokens and forwards MCP traffic transparently. By default the token endpoint and scopes are auto-discovered via [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-05/basic/authorization) and RFC 9728 / RFC 8414. When discovery is unavailable, set a manual token endpoint; see [Servers without OAuth discovery](#servers-without-oauth-discovery). For a shared on-premises deployment instead of local stdio, see [On-premises HTTP deployment](#on-premises-http-deployment-alternative).

To obtain `client_id` and `client_secret`, look for a "Service Account", "API Key", or "Machine-to-Machine Application" option in the remote MCP service's account or developer settings. Naming varies by provider. Well-behaved services issue credentials that already work with their MCP Server published discovery metadata (or provide instructions how to self-grant them), so you normally need only the remote URL plus those two values (see [Notes for MCP Server Developers](#notes-for-mcp-server-developers)).

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
5. On Streamable HTTP, if the remote returns `403` with `insufficient_scope`, can expand scopes, get a new token, and retry once (see [Known Issues](#scope-step-up-and-the-mcp-typescript-sdk))

Also: Streamable HTTP with SSE fallback for transport failures only; fail-closed startup (local transport binds only after a usable token when auth is required and the remote is reachable); automatic reconnection and stale Streamable HTTP session recovery; capability polling; identity/capability forwarding; timeouts on all outgoing calls; generic pass-through (no hardcoded method tables). See [When the proxy starts or stays up](#when-the-proxy-starts-or-stays-up).

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

**Security note:** `npx` downloads and runs the published [`mcp-client-credentials-auth`](https://www.npmjs.com/package/mcp-client-credentials-auth) package on your machine. Use trusted packages only. If discovery is unavailable, see [Servers without OAuth discovery](#servers-without-oauth-discovery).

## Configuration

All configuration via `MCP_CC_PROXY_*` environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_CC_PROXY_REMOTE_MCP_URL` | Yes | — | Remote MCP server URL (`http://` or `https://`) |
| `MCP_CC_PROXY_CLIENT_ID` | Yes | — | OAuth client_id |
| `MCP_CC_PROXY_CLIENT_SECRET` | Yes | — | OAuth client_secret |
| `MCP_CC_PROXY_TOKEN_ENDPOINT` | No | — | IdP token endpoint URL. When set, skips MCP Authorization discovery (PRM/AS) and posts tokens here. See [Servers without OAuth discovery](#servers-without-oauth-discovery). |
| `MCP_CC_PROXY_SCOPES` | No | auto-discovered | Space-separated scopes for the token request. Overrides discovered `scopes_supported`. Required in practice with a manual token endpoint. |
| `MCP_CC_PROXY_DEBUG` | No | `false` | Enable debug logging to stderr |
| `MCP_CC_PROXY_REFRESH_SKEW_SECONDS` | No | `30` | Proactive token refresh window (seconds before expiry) |
| `MCP_CC_PROXY_REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for MCP requests, OAuth discovery, and token acquisition (ms) |
| `MCP_CC_PROXY_STARTUP_TIMEOUT_MS` | No | `60000` | Shared wall-clock budget for a usable access token (when auth is required) and a reachable remote MCP before exit |
| `MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS` | No | `60` | Interval to poll remote capability changes (0 = disabled) |
| `MCP_CC_PROXY_TRANSPORT` | No | `stdio` | Local transport: `stdio` (default) or `http` (on-premises Streamable HTTP). See [On-premises HTTP deployment](#on-premises-http-deployment-alternative). |
| `MCP_CC_PROXY_LISTEN_HOST` | No | `127.0.0.1` | HTTP bind host (HTTP mode only; container image defaults to `0.0.0.0`) |
| `MCP_CC_PROXY_LISTEN_PORT` | No | `8080` | HTTP bind port (HTTP mode only) |
| `MCP_CC_PROXY_LISTEN_PATH` | No | `/mcp` | MCP Streamable HTTP mount path (HTTP mode only) |
| `MCP_CC_PROXY_OAUTH_REDISCOVERY_SECONDS` | No | `3600` | Interval to re-fetch OAuth PRM/AS metadata (both transports). `0` disables the timer only. See [OAuth discovery and scopes at runtime](#oauth-discovery-and-scopes-at-runtime). |

### Servers without OAuth discovery

Use when the remote MCP server accepts `Bearer` tokens but MCP Authorization discovery (RFC 9728 / RFC 8414) is not available. The proxy still uses `client_credentials`; take the token endpoint and scopes from the MCP server provider (do not invent them). Prefer auto-discovery when available. If `MCP_CC_PROXY_TOKEN_ENDPOINT` is set, the manual path is used even when discovery would have worked (no PRM/AS fetch at startup or at runtime).

**Required:** `MCP_CC_PROXY_REMOTE_MCP_URL`, `MCP_CC_PROXY_CLIENT_ID`, `MCP_CC_PROXY_CLIENT_SECRET`, `MCP_CC_PROXY_TOKEN_ENDPOINT`.

**Usually also:** `MCP_CC_PROXY_SCOPES` (there is no discovered `scopes_supported` in this mode).

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

## On-premises HTTP deployment (alternative)

Use this when several MCP clients on a private network should share one outbound `client_credentials` identity, and you do not want to deploy this proxy on every client machine. Prefer local **stdio** (Quick Start) whenever a single client can spawn the proxy; HTTP adds a shared network attack surface.

Set `MCP_CC_PROXY_TRANSPORT=http`. The process listens for cleartext Streamable HTTP on `MCP_CC_PROXY_LISTEN_HOST` / `PORT` / `PATH` (defaults: `127.0.0.1:8080/mcp`). There is **no inbound authentication** on the proxy: anyone who can open an MCP session gets the full remote service-account privilege.

### Recommended HTTPS deployment

Terminate TLS and client authentication at a reverse proxy or ingress (nginx, Envoy, OpenShift Route, etc.). Clients use `https://mcp-proxy.example.com/mcp`; the reverse proxy forwards to `http://127.0.0.1:8080/mcp` or the container service on a private network. This process does not terminate TLS. Do not publish `:8080` to untrusted networks; plain `http://` to a non-loopback host is not a production layout. HTTPS alone is not who-may-call; use mTLS, OAuth at ingress, or IP allowlists in practice. An [MCP gateway](#using-an-mcp-gateway-optional-hardening) can fill this same edge role (TLS + inbound auth) instead of a generic reverse proxy.

```
MCP Client ←→ [HTTPS + edge auth] ←→ Reverse proxy ←→ [HTTP private] ←→ mcp-client-credentials-auth ←→ [HTTPS + Bearer] ←→ Remote MCP Server
                                                                                          ↓
                                                                                    IdP Token Endpoint
                                                                                (client_credentials grant)
```

### How to run

Both options need the same OAuth env vars (`MCP_CC_PROXY_REMOTE_MCP_URL`, `MCP_CC_PROXY_CLIENT_ID`, `MCP_CC_PROXY_CLIENT_SECRET`, plus optional discovery overrides).

#### A. Node / npm (no image)

**From source** (clone this repo, then build and run locally):

```bash
git clone https://github.com/velias/mcp-client-credentials-auth.git
cd mcp-client-credentials-auth
npm ci && npm run build
export MCP_CC_PROXY_REMOTE_MCP_URL=https://mcp.example.com/mcp
export MCP_CC_PROXY_CLIENT_ID=my-service
export MCP_CC_PROXY_CLIENT_SECRET=s3cr3t
# optional: MCP_CC_PROXY_LISTEN_HOST / PORT / PATH (defaults: 127.0.0.1:8080/mcp)
npm run start:http
```

**From the npm registry** (no clone; runs the published [`mcp-client-credentials-auth`](https://www.npmjs.com/package/mcp-client-credentials-auth) package):

```bash
export MCP_CC_PROXY_TRANSPORT=http
export MCP_CC_PROXY_REMOTE_MCP_URL=https://mcp.example.com/mcp
export MCP_CC_PROXY_CLIENT_ID=my-service
export MCP_CC_PROXY_CLIENT_SECRET=s3cr3t
npx -y mcp-client-credentials-auth
```

#### B. Container image (GHCR)

Prerequisites: Docker or Podman. Podman is used in examples; you can use the `docker` command instead.

Image: `ghcr.io/velias/mcp-client-credentials-auth` with tags `X.Y.Z`, `X.Y`, `X`, and `latest`. Defaults: `TRANSPORT=http`, `LISTEN_HOST=0.0.0.0`, port `8080`. 

```bash
podman run --name mcp-cc-proxy --rm \
  -p 127.0.0.1:8080:8080 \
  -e MCP_CC_PROXY_REMOTE_MCP_URL=https://mcp.example.com/mcp \
  -e MCP_CC_PROXY_CLIENT_ID=my-service \
  -e MCP_CC_PROXY_CLIENT_SECRET=s3cr3t \
  ghcr.io/velias/mcp-client-credentials-auth:latest
```

Or pass `--env-file` for credentials.

### Health probes

HTTP mode exposes unauthenticated Kubernetes-style probes (process up only; they do not check the IdP, remote MCP, or token usability). Restrict at ingress if you do not want them reachable beyond the private network.

| Path | Use | Response |
|------|-----|----------|
| `GET /health/live` | Liveness | `200` `{ "status": "ok" }` while the listener is up |
| `GET /health/ready` | Readiness | `200` `{ "status": "ok" }` when accepting traffic; `503` `{ "status": "shutting_down" }` after shutdown starts |

### Security considerations

Beyond the HTTPS layout and [health probes](#health-probes) above:

- **Reachability is authorization** — anyone who can open an MCP session (including via a mis-published `:8080` or the container's `0.0.0.0` bind) gets the full service-account privilege. Keep the listener on a private network only.
- **One shared machine identity** — all sessions share the same Bearer token and scope set (including step-up). Session IDs are capability-like on the private hop. Not multi-tenant; use separate deployments per trust boundary.
- **Credentials and logs** — env-held secrets are a shared blast radius; prefer vault/`--env-file` (see [Security](#security)) and rotate on compromise. Protect log sinks (URLs/client names; secrets are redacted). Keep images and the pinned base digest updated.

### Using an MCP gateway (optional hardening)

A generic **MCP gateway** can address several weak points above (inbound OAuth/OIDC, RBAC/tool ACL, rate limits, audit) and, when it terminates TLS for clients, can replace the separate reverse proxy in [Recommended HTTPS deployment](#recommended-https-deployment). It typically does **not** replace this proxy’s outbound `client_credentials` role.

```
MCP Client ←→ [user/agent identity] ←→ MCP gateway ←→ [trusted private MCP] ←→ mcp-client-credentials-auth ←→ [HTTPS + Bearer] ←→ Remote MCP Server
                                                                                                    ↓
                                                                                              IdP Token Endpoint
                                                                                          (client_credentials grant)
```

- Gateway: inbound auth, who-may-call / tool policy, multi-tenant edge isolation, audit/rate limits, TLS for clients
- This proxy: machine-token acquire/refresh on the private side
- Keep proxy and secrets reachable only from the gateway (or an equivalent trusted path)

## Security

Also see [On-premises HTTP deployment](#on-premises-http-deployment-alternative) when exposing the proxy over the network.

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

Runtime failures use the same three categories in JSON-RPC errors and stderr (`category="authentication"` etc.), prefixed with `mcp-client-credentials-auth`:

| Category | Meaning | Example |
|----------|---------|---------|
| `authentication` | Token/IdP failure (no usable token, scopes, client secret, OAuth discovery) | `mcp-client-credentials-auth [authentication]: no usable access token` |
| `connection` | Proxy cannot reach or stay connected to the remote MCP transport | `mcp-client-credentials-auth [connection]: temporarily unavailable (reconnecting)` |
| `remote` | Remote MCP server returned a protocol/application error (including resource-server 401/403) | `mcp-client-credentials-auth [remote]: …` |

Stderr lines also include `component=mcp-client-credentials-auth` so they remain attributable inside generic MCP client log panels.

### When the proxy starts or stays up

For stdio, MCP clients typically treat the server as healthy when the process is alive and `initialize` succeeds; they do not probe whether your IdP or remote MCP backend is working. This proxy **fail-closes at startup** and **self-heals at runtime** (stdio and HTTP).

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
| Remote MCP / IdP OAuth metadata or discovered scopes change while running | Re-checked on successful remote reconnect (debounced) and on the rediscovery interval. See [OAuth discovery and scopes at runtime](#oauth-discovery-and-scopes-at-runtime). |
| IdP down but a cached access token is still valid | Keeps serving until the token is no longer usable. |
| No usable access token and refresh/auth fails | Requests get a short `authentication` error (`no usable access token`). Indefinite background refresh/retry; resumes when a token is acquired again. |

**Client reconnect:** for stdio MCP, "reconnect" means the client respawns this process and runs a new `initialize`. The MCP spec says clients SHOULD restart an unexpectedly exited server; in practice Cursor and many MCP Clients often need a manual toggle or Reload Window after a red startup failure. Mid-session problems show up on tool/resource calls, not necessarily as a red server dot.

### Token acquired but remote server returns 403

Without `MCP_CC_PROXY_SCOPES`, the proxy requests the full discovered `scopes_supported` string. End users should not need to trim that list: the MCP service that issued your `client_id` / `client_secret` should have granted the scopes discovery will request, or provide you instructions how to self-setup them. If that alignment is wrong, contact the MCP server provider (or use a provider-documented `MCP_CC_PROXY_SCOPES` override). IdP behavior when the requested set is wider than the client grant:

- **Silent dropping** (Keycloak, Auth0): disallowed scopes are removed from the token without error. The proxy starts but may lack permissions; hardest to debug. Runtime `403`/`insufficient_scope` step-up can request more later if the IdP will grant them.
- **Strict rejection** (Okta, AWS Cognito): any disallowed scope fails the token request with `invalid_scope`. Startup exits immediately (**unrecoverable OAuth misconfiguration at the identity provider**). This is a provider/credentials misconfiguration for zero-config use; step-up never runs.
- **`.default` convention** (Entra ID / Azure AD): individual scope names are not accepted; providers should document `MCP_CC_PROXY_SCOPES={resource}/.default`. See [Entra ID (Azure AD) compatibility](#entra-id-azure-ad-compatibility).

**Debugging steps:**

1. Look for the startup scopes log: `OAuth discovery complete` (auto-discovery) or `Using manual token endpoint (skipping OAuth discovery)` (manual token endpoint). The `scopes` field shows what will be requested, or `(default)` / `(none)` if none were set.
2. Request a token directly from your IdP's token endpoint (using `curl` or your IdP's admin UI), decode it at [jwt.io](https://jwt.io) or with `jq`, and inspect the `scope` or `scp` claim to see what was actually granted.
3. Compare with the scopes the remote MCP server requires for the failing operation.
4. If scopes are missing, contact the MCP server operator (or follow their documented `MCP_CC_PROXY_SCOPES` / consent steps).

### OAuth discovery and scopes at runtime

Protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), and scopes for `client_credentials` are resolved at startup (or taken from `MCP_CC_PROXY_SCOPES` / `MCP_CC_PROXY_TOKEN_ENDPOINT`). They are re-checked after a successful remote reconnect and on a schedule (`MCP_CC_PROXY_OAUTH_REDISCOVERY_SECONDS`, default 1 hour; `0` disables the timer only). Reconnect-triggered rediscovery is debounced (at most once every 5 minutes) so a flapping remote does not spam `.well-known` endpoints; the scheduled timer always runs on its interval.

On a **significant** change (authorization server URL, token endpoint, issuer, discovered `scopes_supported` when `MCP_CC_PROXY_SCOPES` is unset, or auth mode flip), the proxy drops the cached access token and acquires a new one. Comparison uses PRM/AS discovery snapshots, not live step-up scope unions. Transient `.well-known` failures (including dual PRM/AS outage, or partial AS failure that would look like `no-auth`) keep the previous discovery and token when the process was already authenticated; rediscovery does not downgrade away from authenticated mode on those paths. With `MCP_CC_PROXY_TOKEN_ENDPOINT`, OAuth PRM/AS rediscovery is skipped entirely. `MCP_CC_PROXY_SCOPES` still wins over discovered scopes; if you rely on that override and scopes must change, update the env and restart.

## Notes for MCP Server Developers

Expect most OAuth-protected MCP servers to serve **both** interactive clients (authorization code + user consent) and M2M clients (this proxy / `client_credentials`). One Protected Resource Metadata document is shared; the tension is scope policy and IdP grants, not two different MCP protocols.

This proxy targets end users with minimal config: ideally remote URL, `client_id`, and `client_secret` only. Design discovery and M2M credential issuance so that path works without `MCP_CC_PROXY_SCOPES`.

### Dual interactive + M2M rules

1. **Publish one PRM** with granular, application-level scopes in `scopes_supported`. Per [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), treat that list as the **baseline for basic functionality**; optional or higher-privilege scopes can be added later via step-up.

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["inventory.read", "orders.read"]
}
```

2. **Use separate OAuth clients** for interactive apps vs service accounts, but the **same resource / audience**. Interactive consent and M2M client grants are different IdP objects; do not assume a user-consent app registration works as a service account for this proxy.

3. **Align M2M grants with discovery.** This proxy (and similar M2M clients) will request the full discovered `scopes_supported` string at startup unless overridden. When you issue a service account / M2M client (or document self-serve setup), grant it at least that baseline. On strict IdPs, a mismatch means this proxy cannot start; on silent-dropping IdPs it starts with a weak token and fails later. End users should not need to hand-edit scopes for a normal install.

4. **Step-up is shared protocol, different UX.** Return `403` + `insufficient_scope` + `scope=` when an operation needs more than the current token (not `401`/`invalid_token` for "missing scope"). Interactive clients can re-consent; M2M step-up only succeeds for scopes the **service account is already allowed** at the IdP. Pre-grant any scopes you expect M2M clients to obtain via step-up, or keep those operations out of the M2M product surface.

5. **If `scopes_supported` lists every advanced scope** (not only the baseline), M2M credentials must be granted that full set (or a documented tier that matches a published subset). Putting "everything" in PRM is fine for interactive least-privilege-via-consent only if M2M issuance matches; otherwise zero-config M2M breaks on strict IdPs.

6. **Document `MCP_CC_PROXY_SCOPES` only as an escape hatch:** IdP needs a different M2M scope format (Entra `.default`), MCP Authorization discovery is unavailable, or you intentionally publish a baseline that M2M clients must override. Do not rely on end users to invent scope lists.

### Entra ID (Azure AD) compatibility

This is the common **format** clash for dual-flow servers: Entra requires `{resource}/.default` for `client_credentials` and rejects individual scope names, while interactive clients still want granular scopes in `scopes_supported`. Document the M2M override in your user setup:

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

Your MCP client sees the remote server's real name. The remote sees a name like `cursor-vscode via mcp-client-credentials-auth v0.2.0` with the client's version. Local capabilities (`sampling`, `roots`, `elicitation`, etc.) are forwarded so server-to-client features work through the proxy.

The proxy also declares the [`io.modelcontextprotocol/oauth-client-credentials`](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) extension on both connections so the remote can apply machine-to-machine policies.

## Known Issues

### Scope step-up and the MCP TypeScript SDK

The MCP TypeScript SDK has known bugs around scope step-up (403 `insufficient_scope` handling):

1. **Scope overwrite instead of accumulation** ([typescript-sdk#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582)): when multiple operations require different scopes, the transport overwrites the active scope instead of merging, causing infinite re-authorization loops.
2. **`fetchToken` ignores challenge scope** ([typescript-sdk#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)): for `client_credentials`, `fetchToken()` uses `clientMetadata.scope` instead of the `WWW-Authenticate` challenge scope, so new scopes never reach the token endpoint.

**This proxy works around both for Streamable HTTP:** on `403` with `WWW-Authenticate` `error="insufficient_scope"` and a `scope` parameter, it merges the challenge into its running scope set, acquires a new token with the full union, retries once, and logs on stderr (`Scope step-up challenge received…` / `Scope step-up token acquired`). Later calls that need more scopes expand the same set (when the IdP grants them). If the IdP rejects the stepped-up scopes, the proxy keeps the previous scopes and access token, returns the original `403`, and stays usable for other requests.

Step-up is a runtime safety net when discovery (or a documented override) produced a valid starting token and the remote later challenges for more scopes the IdP will grant that client. For dual-flow servers, that means M2M step-up only works inside pre-granted service-account scopes; it is not a substitute for aligning `scopes_supported` with M2M credential issuance. A strict IdP rejecting the discovered set at startup is a server/provider configuration problem.

**Not covered:** some servers (including some FastMCP paths) return `401` + `invalid_token` for missing scopes instead of `403` + `insufficient_scope`. That cannot be stepped up reliably; restart after required-scope policy changes, or rely on [OAuth rediscovery](#oauth-discovery-and-scopes-at-runtime) when discovered scopes change and `MCP_CC_PROXY_SCOPES` is unset.

When both upstream issues are fixed in a released SDK, remove the workaround (see the MCP SDK upgrade checklist in [AGENTS.md](AGENTS.md)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines. See [AGENTS.md](AGENTS.md) for architecture and code conventions.

## License

[Apache License 2.0](LICENSE)

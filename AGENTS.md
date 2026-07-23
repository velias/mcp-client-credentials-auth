# AGENTS.md

## Project Overview

`mcp-client-credentials-auth` is a local MCP proxy that authenticates to remote OAuth-protected MCP servers using the `client_credentials` grant, implementing the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) (client secrets variant). It acts as a transparent auth-injecting pipe between an MCP client and a remote MCP server. Local bind is **stdio** by default, or **Streamable HTTP** (`MCP_CC_PROXY_TRANSPORT=http`) for multi-session on-premises deployments.

## Tech Stack

- **Runtime:** Node.js >= 20
- **Language:** TypeScript 6.x (strict mode, CommonJS output)
- **MCP SDK:** `@modelcontextprotocol/sdk` (both client and server modules)
- **Validation:** Zod 4 (`zod/v4` for config validation, `zod/v3` for SDK interop; see SDK upgrade checklist)
- **Test framework:** Vitest 4
- **Linter:** ESLint with typescript-eslint (flat config)

## Directory Layout

```
src/
  index.ts                   # Entry point: config, auth ready, stdio|http branch, shutdown
  config.ts                  # MCP_CC_PROXY_* env var loading, zod validation
  errors.ts                  # Proxy error categories, formatting, client-facing McpError wrap
  logger.ts                  # Structured stderr logger (key=value, no deps)
  backoff.ts                 # Shared sleep + jittered exponential backoff
  proxy-utils.ts             # sanitizeMeta, client identity helpers, PKG_VERSION
  proxy-handle.ts            # Shared ProxyHandle type
  proxy-session.ts           # Local Server <-> remote Client session (reconnect, poll, flows)
  proxy-stdio.ts             # createStdioProxy: Phase 1 + one session + StdioServerTransport
  proxy-http.ts              # createHttpProxy: Phase 1 + Express multi-session + /health/live|/ready
  remote-connect.ts          # Streamable HTTP / SSE connectWithTransportFallback
  remote-mcp-discovery.ts    # Phase 1 remote MCP initialize/caps (fail-closed)
  remote-oauth-discovery.ts  # RFC 9728/8414 well-known + rediscovery compare/snapshot
  token-manager.ts           # Facade: auth mode/provider, prefetch, step-up, rediscovery API
  token-refresh.ts           # Proactive IdP token refresh timer/backoff
  scope-step-up.ts           # 403 insufficient_scope fetch workaround (SDK #2255/#1582)
test/
  config.test.ts             # Config parsing, validation, defaults, transport/listen
  errors.test.ts             # Error classification and mcp-client-credentials-auth [category] format
  token-manager.test.ts      # Discovery, auth modes, prefetch, refresh, step-up, rediscovery
  scope-step-up.test.ts      # Scope merge + step-up fetch wrapper
  proxy.test.ts              # Stdio E2E with in-memory MCP transports, reconnection
  proxy-advanced.test.ts     # Auth usability gating, remote error wrapping, polling
  proxy-resilience.test.ts  # Fail-closed Phase 1 startup, Phase 3 reconnect, dynamic auth
  proxy-http.test.ts        # HTTP health probes, session lifecycle, no process.exit on disconnect
  logger.test.ts             # Log output formatting, levels, secret redaction
```

Naming: `remote-*` = outbound toward the remote MCP (connect, MCP discovery, OAuth well-known); `proxy-*` = local-facing bind/session; `token-*` = IdP token lifecycle.

## Architecture Notes

- **stdio reserved for JSON-RPC** -- all proxy logging goes to stderr (`logger.ts`), never stdout. The MCP protocol's own `notifications/message` logging from the remote server passes through to the local client via fallback handlers. The proxy does not inject its own MCP-level log notifications because it mirrors the remote server's declared capabilities (including whether `logging` is supported).
- **Fail-closed startup** -- do not bind local transport until auth is ready (`no-auth`, or `authenticated` with a usable access token) **and** Phase 1 remote discovery succeeds. `waitUntilAuthReady()` and required Phase 1 share one wall-clock budget (`startupTimeoutMs` / `MCP_CC_PROXY_STARTUP_TIMEOUT_MS`). On expiry, `unsupported-grant`, or unrecoverable auth errors (`isUnrecoverableStartupAuthError`), exit non-zero immediately (no startup retries). `formatUnrecoverableOAuthMisconfig(detail, source)` names the failure site: `idp` (IdP rejected the token request) vs `mcp-server` (remote MCP rejected the Bearer token), and tells the operator to contact the MCP server provider. Transient network/remote outages retry until the deadline. No fake default capabilities.
- **Local transport** -- `MCP_CC_PROXY_TRANSPORT=stdio|http` (default `stdio`). Stdio: one session; stdin close exits. HTTP: Express + `StreamableHTTPServerTransport` multi-session; process stays up across session connect/disconnect; `/health/live` + `/health/ready` (ready returns 503 while shutting down); no inbound auth in v1 (document reverse-proxy HTTPS). Shared process-level `TokenManager` / Bearer token across sessions.
- **Two-phase connection** -- Phase 1 discovery (proxy identity) proves remote reachability and reads server info/capabilities before local bind; after the local client finishes `initialize`, Phase 3 reconnects with the local client's actual identity/capabilities (per session in HTTP mode)
- **Protocol-version agnostic** -- uses SDK fallback handlers for bidirectional pass-through
- **No hardcoded method tables** -- all 4 message flows use `fallbackRequestHandler`/`fallbackNotificationHandler`
- **`_meta` sanitization** -- auth-like keys stripped from all client-to-server messages (requests and notifications) before forwarding to remote
- **Transport fallback** -- Streamable HTTP first, SSE only for `connection`-class failures (skip SSE on `authentication` / `remote`; both transports share the same authProvider). Phase 1 discovery and Phase 3/runtime connects share `connectWithTransportFallback()` in `remote-connect.ts`; do not re-duplicate the HTTP/SSE connect path.
- **OAuth rediscovery** -- re-fetch RFC 9728 / RFC 8414 on successful remote reconnect and on `MCP_CC_PROXY_OAUTH_REDISCOVERY_SECONDS` (default 3600; `0` disables timer). Coalesced process-wide. Significant PRM/AS change drops cached token and reacquires; dual well-known failure and partial AS failure that surfaces as `no-auth` keep prior discovery/token when already `authenticated` (never downgrade auth gating on rediscovery). Skipped when `MCP_CC_PROXY_TOKEN_ENDPOINT` is set.
- **Scope step-up workaround** -- Streamable HTTP uses a custom `fetch` (`scope-step-up.ts` via `tokenManager.getScopeStepUpFetch()`) that intercepts `403` + `insufficient_scope` + `scope=`, merges scopes into the live `ClientCredentialsProvider.clientMetadata.scope`, reacquires a token, and retries once (avoids SDK #2255/#1582). Scopes and tokens commit only after a successful `auth()`; on IdP rejection or other step-up failure, restore the pre-flight baseline so a bad challenge cannot poison scopes or wipe a working access token. Remove when both upstream issues are fixed (see upgrade checklist).
- **Automatic reconnection** -- after startup, detects remote `onclose`, Phase 3 connection failure, or stale Streamable HTTP session (spec HTTP 404 / session-loss message without `onclose`), reconnects indefinitely with exponential backoff (1s--60s with jitter via `backoff.ts`), restarts polling; backoff resets after a connection is stable for 30s. Stale-session recovery invalidates the old client, coalesces concurrent recoveries, retries the failed request once, and logs WARN `Remote Streamable HTTP session lost, recreating session` then INFO `Remote Streamable HTTP session reacquired`. Requests get `connection` errors while `!remoteClient`.
- **Runtime auth gaps** -- if auth is required and `hasUsableAccessToken()` is false, requests get a short `authentication` MCP error (`no usable access token`); proactive refresh keeps retrying in the background (no process exit)
- **Manual token endpoint** -- optional `MCP_CC_PROXY_TOKEN_ENDPOINT` skips MCP Authorization discovery (RFC 9728 / RFC 8414); seeds `ClientCredentialsProvider` with `discoveryState` / `validateResourceURL` so SDK `auth()` hits the configured token URL. Scopes come only from `MCP_CC_PROXY_SCOPES` in this mode. Startup still requires a successful prefetch within the shared startup deadline.
- **Local disconnect cleanup** -- stdio: detects `localServer.onclose` (stdin closed), awaits remote close with 2s timeout, then exits. HTTP: session close tears down that session only (no `process.exit`)
- **Timeouts on all outgoing calls** -- `requestTimeoutMs` applied per-request via SDK `{ timeout }` option for MCP calls, and per-call via `AbortSignal.timeout` for OAuth discovery and token acquisition. Transport constructors do NOT receive a signal (a long-lived signal would go stale and break all requests after it fires).
- **Proactive refresh via `saveTokens` hook** -- monkey-patches `ClientCredentialsProvider.saveTokens` to schedule a timer; this is a deliberate coupling to SDK internals (see upgrade checklist)
- **Token acquire coalesce** -- process-wide `inflightAcquire` for prefetch/refresh/step-up/rediscovery; SDK `auth` export is patched so multi-session 401→`auth()` joins the same flight (see upgrade checklist)
- **Scope override** -- `MCP_CC_PROXY_SCOPES` env var takes priority over discovered `scopes_supported` from resource metadata. This decouples the token request scopes from the server's discovery metadata, which is necessary when the IdP requires a different scope format (e.g., Entra ID's `{resource}/.default`).

## Performance Conventions

- Token cached in memory with proactive refresh timer (`refreshSkewSeconds` before expiry)
- Proactive refresh retries up to 3 fast attempts (interval adapts to fit within skew window), then switches to extended exponential backoff (30s--5min) to keep trying proactively rather than relying solely on reactive 401 handling
- Dynamic `authProvider` -- `connectRemote()` calls `tokenManager.getAuthProvider()` each time, so reconnections use the current provider
- `waitUntilAuthReady()` / `prefetch()` acquire a real token before local transport binds so the first request never hits a cold path
- Proactive refresh deduplication (`inflightRefresh`) and acquire coalesce (`inflightAcquire`) prevent concurrent IdP token storms
- Single process, no worker threads needed

## Code Style

- No barrel exports (`index.ts` files that just re-export)
- Explicit `.js` extension in imports (required for CommonJS interop)
- Prefer `const` and `function` declarations over `let` and arrow expressions
- No classes unless the SDK requires them (prefer factory functions)
- Error messages: human-readable, include actionable context
- Do not use `--` (double dash) as em-dash in `README.md`; use proper punctuation (semicolons, commas, or separate sentences). `--` is acceptable in code, comments, and internal docs like AGENTS.md.

## Logging Conventions

All logging goes to stderr via `logger.ts`. stdout is reserved for JSON-RPC.

### Level guidelines

- **ERROR** -- unrecoverable failures that stop a flow (connection failed permanently, cannot start proxy)
- **WARN** -- degraded state that the proxy can recover from or work around (refresh failed but will retry, poll failed, transport fallback to SSE)
- **INFO** -- key lifecycle events visible without debug mode (startup, connected, reconnected, shutdown, capability changes, OAuth discovery result)
- **DEBUG** -- verbose details only useful when actively debugging (per-message forwarding, timer scheduling, internal state transitions)

### Patterns

- **Before+after for network calls**: every outgoing call that could hang should have a log BEFORE it starts (at INFO for startup-path calls, DEBUG for recurring calls like refresh) and a log on completion/failure. This lets you see where things get stuck.
- **No success log without a corresponding start log**: if you log "X successful", there must be a preceding "Starting X" or "Attempting X" so silence between them is visible.
- **Actionable context in warnings/errors**: include what will happen next ("retrying before startup deadline", "scheduling retry", "proxy will stop").
- **Never log secrets**: the logger redacts values for keys matching secret patterns (token, secret, authorization, etc.). Do not pass raw tokens as the `msg` argument; put them in the `meta` object where redaction applies.
- **Structured metadata**: pass context as the second argument `meta` object, not interpolated into the message string. This keeps logs parseable.
- **Component field**: every log line includes `component=mcp-client-credentials-auth` (from `logger.ts`).
- **Failure categories**: runtime failures use exactly three categories via `errors.ts` -- `authentication` (IdP/token), `connection` (transport), `remote` (remote MCP response). Client-facing messages are `mcp-client-credentials-auth [<category>]: <detail>`; matching failure logs must include `category=<same>` in meta.

## Testing Conventions

- All tests use Vitest with `globals: true`
- Mock external dependencies with `vi.mock()` and `vi.spyOn()`
- Use `InMemoryTransport` from SDK for proxy integration tests
- No real network calls in tests
- Test file naming: `test/<module>.test.ts`
- **Proxy test teardown order**: always close `proxyHandle` before `endClient` in `afterEach`. Closing the end client first triggers `localServer.onclose` which calls `process.exit(0)` (Vitest intercepts this and throws, causing unhandled rejections). Closing the proxy first sets `closingIntentionally = true`, preventing the exit.

## MCP SDK Upgrade Checklist

When bumping `@modelcontextprotocol/sdk`, check the following areas where the proxy depends on SDK internals or undocumented behaviors:

### Authentication flow (`token-manager.ts` / `remote-oauth-discovery.ts` / `token-refresh.ts`)

- **`auth()` function signature** -- we call `auth(provider, { serverUrl, fetchFn })` directly (via `originalSdkAuth`). If the options shape or return type (`AuthResult`) changes, `prefetch()` and proactive refresh break.
- **SDK `auth` export patch** -- we replace `sdkAuth.auth` so multi-session 401→`auth()` joins `inflightAcquire`. If the SDK switches to a closed-over import (not property lookup), the patch stops working.
- **`ClientCredentialsProvider.saveTokens`** -- we monkey-patch `saveTokens` to intercept token storage and schedule proactive refresh. If the provider's token lifecycle changes (e.g., refresh handled internally), our hook may become redundant or conflict.
- **`OAuthTokens.expires_in`** -- our proactive refresh depends on `expires_in` being passed through `saveTokens`. If the SDK starts consuming/removing it before calling `saveTokens`, our timer won't schedule.
- **`discoveryState` / `saveDiscoveryState` / `validateResourceURL`** -- manual token endpoint mode (and post-discovery seeding) assigns these optional hooks on `ClientCredentialsProvider` so `auth()` skips rediscovery and omits the RFC 8707 `resource` param. If the SDK changes how cached discovery state is consumed, that path breaks.
- **Discovery functions** -- `discoverOAuthProtectedResourceMetadata` and `discoverAuthorizationServerMetadata` signatures (especially the `fetchFn` parameter position).

### Transport layer (`remote-connect.ts` / `proxy-http.ts`)

- **`StreamableHTTPClientTransport` options** -- we pass `{ authProvider, fetch: tokenManager.getScopeStepUpFetch() }`. The custom `fetch` must remain global `fetch` (not `timeoutFetch`) so long-lived SSE GETs are not aborted by `AbortSignal.timeout`. We intentionally do NOT pass `requestInit.signal`. Per-request MCP timeouts use the SDK `{ timeout }` option.
- **`SSEClientTransport` options** -- `{ authProvider }` only (no scope step-up fetch; SSE has no equivalent upscoping path).
- **`createMcpExpressApp` / `StreamableHTTPServerTransport`** -- HTTP local bind depends on these; verify sessionIdGenerator / onsessioninitialized / handleRequest still work for multi-session.
- **Scope step-up removal** -- when [#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255) and [#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582) are both fixed in a released SDK: delete `src/scope-step-up.ts` and its tests, remove `stepUpScopes` / `getScopeStepUpFetch` from `token-manager.ts`, drop the `fetch:` option in `remote-connect.ts`, and update README Known Issues.
- **`Client.onclose`** -- we rely on `onclose` firing when the remote transport disconnects. If the SDK changes to an event emitter or renames this, reconnection breaks.
- **`Client.connect()` re-entrancy** -- we create a new `Client` instance for each reconnection. Verify the SDK doesn't introduce singleton restrictions or session ID reuse that would prevent this.
- **401 retry behavior** -- the SDK's transport handles 401 responses by calling `auth()` internally. Our proactive refresh and acquire coalesce reduce stampede risk; if the SDK removes automatic 401 retry, requests will fail when proactive refresh is late.

### Protocol abstractions (`proxy-session.ts`)

- **`fallbackRequestHandler` / `fallbackNotificationHandler`** -- our entire pass-through design depends on these catch-all handlers. If the SDK removes them or changes precedence (e.g., registered handlers always win), proxying breaks.
- **`Server.request()` / `Server.notification()`** -- we use these to forward messages from remote to local. Check that they still accept arbitrary method strings.
- **`getServerCapabilities()` / `getClientCapabilities()`** -- used for capability forwarding. These should remain available after `connect()`.
- **`getServerVersion()` / `getClientVersion()`** -- used for identity forwarding (remote server name shown to local client, local client name forwarded to remote). If renamed or removed, identity forwarding breaks.
- **`sendToolListChanged` / `sendResourceListChanged` / `sendPromptListChanged`** -- we call these to notify the local client of changes. If the SDK renames or gates them behind capability checks, polling notifications break.

### Zod compatibility (`proxy-session.ts`)

- **`zod/v3` import** -- `proxy-session.ts` imports from `zod/v3` because the SDK's `Client.request()` / `Server.request()` expect a zod v3 `ZodType` for the response schema. `config.ts` uses `zod/v4` for config validation. If the SDK migrates to zod v4 types internally, the `zod/v3` import in `proxy-session.ts` can be switched to `zod/v4`.

### Known SDK issues to re-check

- **Scope step-up bugs** ([#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582), [#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)) -- this repo ships a Streamable HTTP fetch workaround. When **both** are fixed upstream, remove the workaround (see transport checklist bullet) and trim README Known Issues.
- **`SSEClientTransport` deprecation** -- the SDK marks it deprecated. If removed entirely, delete our SSE fallback code.

### How to verify

1. `npm run build` -- catches type-level breakage
2. `npm test` -- proxy tests exercise all 4 message flows, reconnection, and identity forwarding via mocked SDK transports
3. Manual test with a real remote MCP server -- confirms auth flow, transport negotiation, and token refresh work end-to-end (not covered by unit tests)

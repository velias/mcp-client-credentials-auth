# AGENTS.md

## Project Overview

`mcp-client-credentials-auth` is a local stdio MCP proxy that authenticates to remote OAuth-protected MCP servers using the `client_credentials` grant, implementing the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) (client secrets variant). It acts as a transparent auth-injecting pipe between an MCP client and a remote MCP server.

## Tech Stack

- **Runtime:** Node.js >= 18
- **Language:** TypeScript 5.x (strict mode, CommonJS output)
- **MCP SDK:** `@modelcontextprotocol/sdk` (both client and server modules)
- **Validation:** Zod 4 (`zod/v4` for config validation, `zod/v3` for SDK interop; see SDK upgrade checklist)
- **Test framework:** Vitest 4
- **Linter:** ESLint with typescript-eslint (flat config)

## Directory Layout

```
src/
  index.ts             # Entry point: config, connect, start, shutdown
  config.ts            # MCP_CC_PROXY_* env var loading, zod validation
  logger.ts            # Structured stderr logger (key=value, no deps)
  token-manager.ts     # OAuth discovery, client_credentials, cache, refresh
  proxy.ts             # Wire local Server <-> remote Client
test/
  config.test.ts           # Config parsing, validation, defaults, scope override
  token-manager.test.ts    # Discovery, auth modes, scope resolution, prefetch, proactive refresh
  proxy.test.ts            # E2E with in-memory MCP transports, reconnection
  proxy-advanced.test.ts   # Auth mode error handling (unsupported-grant, discovery-failed)
  proxy-resilience.test.ts # Startup/connection failure recovery, dynamic auth
  logger.test.ts           # Log output formatting, levels, secret redaction
```

## Architecture Notes

- **stdio reserved for JSON-RPC** -- all proxy logging goes to stderr (`logger.ts`), never stdout. The MCP protocol's own `notifications/message` logging from the remote server passes through to the local client via fallback handlers. The proxy does not inject its own MCP-level log notifications because it mirrors the remote server's declared capabilities (including whether `logging` is supported).
- **Best-effort discovery** -- Phase 1 discovery connection is best-effort; if the remote MCP server is unreachable at startup, the proxy starts with default capabilities (tools, resources, prompts) and defers connection to when the local client connects. Reconnection with exponential backoff handles eventual recovery.
- **Two-phase connection** -- discovery connection gets remote server info, then a real connection is established with the local client's actual identity/capabilities after the local handshake completes
- **Protocol-version agnostic** -- uses SDK fallback handlers for bidirectional pass-through
- **No hardcoded method tables** -- all 4 message flows use `fallbackRequestHandler`/`fallbackNotificationHandler`
- **`_meta` sanitization** -- auth-like keys stripped from all client-to-server messages (requests and notifications) before forwarding to remote
- **Transport fallback** -- Streamable HTTP first, SSE if that fails
- **Automatic reconnection** -- detects remote `onclose` or Phase 3 connection failure, reconnects with exponential backoff (1s--60s with jitter), restarts polling; backoff resets after a connection is stable for 30s
- **OAuth re-discovery** -- if IdP is unreachable at startup, stays in `discovery-failed` mode (rejects requests with error) and retries discovery with exponential backoff (5s--60s); transitions to `authenticated` mode when IdP recovers
- **Local disconnect cleanup** -- detects `localServer.onclose` (stdin closed), awaits remote close with 2s timeout, then exits
- **Timeouts on all outgoing calls** -- `requestTimeoutMs` applied per-request via SDK `{ timeout }` option for MCP calls, and per-call via `AbortSignal.timeout` for OAuth discovery and token acquisition. Transport constructors do NOT receive a signal (a long-lived signal would go stale and break all requests after it fires).
- **Proactive refresh via `saveTokens` hook** -- monkey-patches `ClientCredentialsProvider.saveTokens` to schedule a timer; this is a deliberate coupling to SDK internals (see upgrade checklist)
- **Scope override** -- `MCP_CC_PROXY_SCOPES` env var takes priority over discovered `scopes_supported` from resource metadata. This decouples the token request scopes from the server's discovery metadata, which is necessary when the IdP requires a different scope format (e.g., Entra ID's `{resource}/.default`).

## Performance Conventions

- Token cached in memory with proactive refresh timer (`refreshSkewSeconds` before expiry)
- Proactive refresh retries up to 3 fast attempts (interval adapts to fit within skew window), then switches to extended exponential backoff (30s--5min) to keep trying proactively rather than relying solely on reactive 401 handling
- Dynamic `authProvider` -- `connectRemote()` calls `tokenManager.getAuthProvider()` each time, so reconnections after IdP re-discovery use the correct provider
- `prefetch()` acquires a real token at startup via `auth()` so the first request never hits a cold path
- Proactive refresh deduplication (`inflightRefresh`) prevents concurrent refresh attempts
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
- **Actionable context in warnings/errors**: include what will happen next ("will retry on first request", "scheduling retry", "proxy will stop").
- **Never log secrets**: the logger redacts values for keys matching secret patterns (token, secret, authorization, etc.). Do not pass raw tokens as the `msg` argument; put them in the `meta` object where redaction applies.
- **Structured metadata**: pass context as the second argument `meta` object, not interpolated into the message string. This keeps logs parseable.

## Testing Conventions

- All tests use Vitest with `globals: true`
- Mock external dependencies with `vi.mock()` and `vi.spyOn()`
- Use `InMemoryTransport` from SDK for proxy integration tests
- No real network calls in tests
- Test file naming: `test/<module>.test.ts`
- **Proxy test teardown order**: always close `proxyHandle` before `endClient` in `afterEach`. Closing the end client first triggers `localServer.onclose` which calls `process.exit(0)` (Vitest intercepts this and throws, causing unhandled rejections). Closing the proxy first sets `closingIntentionally = true`, preventing the exit.

## MCP SDK Upgrade Checklist

When bumping `@modelcontextprotocol/sdk`, check the following areas where the proxy depends on SDK internals or undocumented behaviors:

### Authentication flow (`token-manager.ts`)

- **`auth()` function signature** -- we call `auth(provider, { serverUrl, fetchFn })` directly. If the options shape or return type (`AuthResult`) changes, `prefetch()` and `performRefresh()` break.
- **`ClientCredentialsProvider.saveTokens`** -- we monkey-patch `saveTokens` to intercept token storage and schedule proactive refresh. If the provider's token lifecycle changes (e.g., refresh handled internally), our hook may become redundant or conflict.
- **`OAuthTokens.expires_in`** -- our proactive refresh depends on `expires_in` being passed through `saveTokens`. If the SDK starts consuming/removing it before calling `saveTokens`, our timer won't schedule.
- **Discovery functions** -- `discoverOAuthProtectedResourceMetadata` and `discoverAuthorizationServerMetadata` signatures (especially the `fetchFn` parameter position).

### Transport layer (`proxy.ts`)

- **`StreamableHTTPClientTransport` options** -- we pass `{ authProvider }`. We intentionally do NOT pass `requestInit.signal` because a transport-level `AbortSignal.timeout` goes stale after firing and breaks all subsequent requests. Per-request timeouts are handled via the SDK's `{ timeout }` option instead.
- **`SSEClientTransport` options** -- same pattern with `authProvider` only.
- **`Client.onclose`** -- we rely on `onclose` firing when the remote transport disconnects. If the SDK changes to an event emitter or renames this, reconnection breaks.
- **`Client.connect()` re-entrancy** -- we create a new `Client` instance for each reconnection. Verify the SDK doesn't introduce singleton restrictions or session ID reuse that would prevent this.
- **401 retry behavior** -- the SDK's transport handles 401 responses by calling `auth()` internally. Our proactive refresh reduces how often this path is hit, but if the SDK removes automatic 401 retry, requests will fail when proactive refresh is late.

### Protocol abstractions (`proxy.ts`)

- **`fallbackRequestHandler` / `fallbackNotificationHandler`** -- our entire pass-through design depends on these catch-all handlers. If the SDK removes them or changes precedence (e.g., registered handlers always win), proxying breaks.
- **`Server.request()` / `Server.notification()`** -- we use these to forward messages from remote to local. Check that they still accept arbitrary method strings.
- **`getServerCapabilities()` / `getClientCapabilities()`** -- used for capability forwarding. These should remain available after `connect()`.
- **`getServerVersion()` / `getClientVersion()`** -- used for identity forwarding (remote server name shown to local client, local client name forwarded to remote). If renamed or removed, identity forwarding breaks.
- **`sendToolListChanged` / `sendResourceListChanged` / `sendPromptListChanged`** -- we call these to notify the local client of changes. If the SDK renames or gates them behind capability checks, polling notifications break.

### Zod compatibility (`proxy.ts`)

- **`zod/v3` import** -- `proxy.ts` imports from `zod/v3` because the SDK's `Client.request()` / `Server.request()` expect a zod v3 `ZodType` for the response schema. `config.ts` uses `zod/v4` for config validation. If the SDK migrates to zod v4 types internally, the `zod/v3` import in `proxy.ts` can be switched to `zod/v4`.

### Known SDK issues to re-check

- **Scope step-up bugs** ([#1582](https://github.com/modelcontextprotocol/typescript-sdk/issues/1582), [#2255](https://github.com/modelcontextprotocol/typescript-sdk/issues/2255)) -- if fixed upstream, we can remove the "Known Issues" section from README and potentially remove the workaround note.
- **`SSEClientTransport` deprecation** -- the SDK marks it deprecated. If removed entirely, delete our SSE fallback code.

### How to verify

1. `npm run build` -- catches type-level breakage
2. `npm test` -- proxy tests exercise all 4 message flows, reconnection, and identity forwarding via mocked SDK transports
3. Manual test with a real remote MCP server -- confirms auth flow, transport negotiation, and token refresh work end-to-end (not covered by unit tests)

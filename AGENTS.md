# AGENTS.md

## Project Overview

`mcp-client-credentials-auth` is a local stdio MCP proxy that authenticates to remote OAuth-protected MCP servers using the `client_credentials` grant, implementing the [MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) (client secrets variant). It acts as a transparent auth-injecting pipe between an MCP client and a remote MCP server.

## Tech Stack

- **Runtime:** Node.js >= 18
- **Language:** TypeScript 5.x (strict mode, CommonJS output)
- **MCP SDK:** `@modelcontextprotocol/sdk` (both client and server modules)
- **Validation:** Zod 4
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
  config.test.ts       # Config parsing, validation, defaults
  token-manager.test.ts # Discovery, auth modes, invalidation
  proxy.test.ts        # E2E with in-memory MCP transports
```

## Architecture Notes

- **stdio reserved for JSON-RPC** -- all logging goes to stderr
- **Protocol-version agnostic** -- uses SDK fallback handlers for bidirectional pass-through
- **No hardcoded method tables** -- all 4 message flows use `fallbackRequestHandler`/`fallbackNotificationHandler`
- **`_meta` sanitization** -- auth-like keys stripped before forwarding to remote
- **Transport fallback** -- Streamable HTTP first, SSE if that fails

## Performance Conventions

- Token cached in memory with proactive refresh (no on-demand latency)
- In-flight de-duplication prevents thundering herd on token endpoint
- Single process, no worker threads needed

## Code Style

- No barrel exports (`index.ts` files that just re-export)
- Explicit `.js` extension in imports (required for CommonJS interop)
- Prefer `const` and `function` declarations over `let` and arrow expressions
- No classes unless the SDK requires them (prefer factory functions)
- Error messages: human-readable, include actionable context
- Do not use `--` (double dash) as em-dash in `README.md`; use proper punctuation (semicolons, commas, or separate sentences). `--` is acceptable in code, comments, and internal docs like AGENTS.md.

## Testing Conventions

- All tests use Vitest with `globals: true`
- Mock external dependencies with `vi.mock()` and `vi.spyOn()`
- Use `InMemoryTransport` from SDK for proxy integration tests
- No real network calls in tests
- Test file naming: `test/<module>.test.ts`

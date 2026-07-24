import { z } from 'zod/v4';

const httpOrHttpsUrl = z.url().check(
  z.refine((url) => {
    try {
      const scheme = new URL(url).protocol;
      return scheme === 'http:' || scheme === 'https:';
    } catch {
      return false;
    }
  }, 'URL scheme must be http or https'),
);

function normalizeListenPath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path;
}

export const ConfigSchema = z.object({
  remoteMcpUrl: httpOrHttpsUrl,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshSkewSeconds: z.number().int().positive().default(30),
  requestTimeoutMs: z.number().int().positive().default(30000),
  startupTimeoutMs: z.number().int().positive().default(60000),
  capabilitiesPollSeconds: z.number().int().min(0).default(60),
  scopes: z.string().optional(),
  tokenEndpoint: httpOrHttpsUrl.optional(),
  debug: z.boolean().default(false),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  listenHost: z.string().min(1).default('127.0.0.1'),
  listenPort: z.number().int().min(1).max(65535).default(8080),
  listenPath: z.string().min(1).default('/mcp').transform(normalizeListenPath),
  oauthRediscoverySeconds: z.number().int().min(0).default(3600),
  /** HTTP mode: evict sessions with no inbound MCP traffic for this long. `0` disables. */
  httpSessionIdleSeconds: z.number().int().min(0).default(1800),
  /**
   * Audit tools/resources/prompts invoke + discovery to stderr.
   * Resolved in loadConfig: default false for stdio, true for http when env unset.
   */
  auditCalls: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(): Config {
  const transport = process.env.MCP_CC_PROXY_TRANSPORT || 'stdio';
  const raw = {
    remoteMcpUrl: process.env.MCP_CC_PROXY_REMOTE_MCP_URL,
    clientId: process.env.MCP_CC_PROXY_CLIENT_ID,
    clientSecret: process.env.MCP_CC_PROXY_CLIENT_SECRET,
    refreshSkewSeconds: parseNumber(
      process.env.MCP_CC_PROXY_REFRESH_SKEW_SECONDS,
    ),
    requestTimeoutMs: parseNumber(process.env.MCP_CC_PROXY_REQUEST_TIMEOUT_MS),
    startupTimeoutMs: parseNumber(process.env.MCP_CC_PROXY_STARTUP_TIMEOUT_MS),
    capabilitiesPollSeconds: parseNumber(
      process.env.MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS,
    ),
    scopes: process.env.MCP_CC_PROXY_SCOPES || undefined,
    tokenEndpoint: process.env.MCP_CC_PROXY_TOKEN_ENDPOINT || undefined,
    debug: parseBool(process.env.MCP_CC_PROXY_DEBUG),
    transport: process.env.MCP_CC_PROXY_TRANSPORT || undefined,
    listenHost: process.env.MCP_CC_PROXY_LISTEN_HOST || undefined,
    listenPort: parseNumber(process.env.MCP_CC_PROXY_LISTEN_PORT),
    listenPath: process.env.MCP_CC_PROXY_LISTEN_PATH || undefined,
    oauthRediscoverySeconds: parseNumber(
      process.env.MCP_CC_PROXY_OAUTH_REDISCOVERY_SECONDS,
    ),
    httpSessionIdleSeconds: parseNumber(
      process.env.MCP_CC_PROXY_HTTP_SESSION_IDLE_SECONDS,
    ),
    auditCalls: process.env.MCP_CC_PROXY_AUDIT_CALLS
      ? parseBool(process.env.MCP_CC_PROXY_AUDIT_CALLS)
      : transport === 'http',
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration:\n${issues}\n\nRequired env vars: MCP_CC_PROXY_REMOTE_MCP_URL, MCP_CC_PROXY_CLIENT_ID, MCP_CC_PROXY_CLIENT_SECRET`,
    );
  }

  return result.data;
}

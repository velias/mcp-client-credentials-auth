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

export const ConfigSchema = z.object({
  remoteMcpUrl: httpOrHttpsUrl,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshSkewSeconds: z.number().int().positive().default(30),
  requestTimeoutMs: z.number().int().positive().default(30000),
  capabilitiesPollSeconds: z.number().int().min(0).default(60),
  scopes: z.string().optional(),
  tokenEndpoint: httpOrHttpsUrl.optional(),
  debug: z.boolean().default(false),
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
  const raw = {
    remoteMcpUrl: process.env.MCP_CC_PROXY_REMOTE_MCP_URL,
    clientId: process.env.MCP_CC_PROXY_CLIENT_ID,
    clientSecret: process.env.MCP_CC_PROXY_CLIENT_SECRET,
    refreshSkewSeconds: parseNumber(
      process.env.MCP_CC_PROXY_REFRESH_SKEW_SECONDS,
    ),
    requestTimeoutMs: parseNumber(process.env.MCP_CC_PROXY_REQUEST_TIMEOUT_MS),
    capabilitiesPollSeconds: parseNumber(
      process.env.MCP_CC_PROXY_CAPABILITIES_POLL_SECONDS,
    ),
    scopes: process.env.MCP_CC_PROXY_SCOPES || undefined,
    tokenEndpoint: process.env.MCP_CC_PROXY_TOKEN_ENDPOINT || undefined,
    debug: parseBool(process.env.MCP_CC_PROXY_DEBUG),
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

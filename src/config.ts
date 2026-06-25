import { z } from 'zod/v4';

export const ConfigSchema = z.object({
  remoteMcpUrl: z.url().check(
    z.refine((url) => {
      try {
        const scheme = new URL(url).protocol;
        return scheme === 'http:' || scheme === 'https:';
      } catch {
        return false;
      }
    }, 'URL scheme must be http or https'),
  ),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshSkewSeconds: z.number().int().positive().default(30),
  requestTimeoutMs: z.number().int().positive().default(30000),
  capabilitiesPollSeconds: z.number().int().min(0).default(60),
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

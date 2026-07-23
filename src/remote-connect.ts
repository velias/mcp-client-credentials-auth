import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { classifyError, errorDetail } from './errors.js';
import type { Logger } from './logger.js';

/** SSE uses the same authProvider; only retry on transport-shaped failures. */
function shouldFallbackToSse(err: unknown): boolean {
  return classifyError(err) === 'connection';
}

/**
 * Connect via Streamable HTTP; on connection-class failure only, fall back to SSE.
 * Both transports share the same authProvider; Streamable HTTP may use a custom fetch.
 */
export async function connectWithTransportFallback(
  client: Client,
  remoteUrl: URL,
  options: {
    authProvider: OAuthClientProvider | undefined;
    fetch?: FetchLike;
    logger: Logger;
    /** Distinguishes discovery vs runtime log wording (tests assert these strings). */
    phase: 'discovery' | 'runtime';
    clientName?: string;
  },
): Promise<void> {
  const { authProvider, logger, phase, clientName } = options;
  const meta = clientName !== undefined ? { clientName } : undefined;
  const msgs =
    phase === 'discovery'
      ? {
          streamableOk: 'Discovery: connected via Streamable HTTP',
          noSse: 'Streamable HTTP connection failed, not trying SSE fallback',
          trySse: 'Streamable HTTP connection failed, trying SSE fallback',
          sseOk: 'Discovery: connected to remote MCP server via SSE',
        }
      : {
          streamableOk: 'Connected to remote MCP server via Streamable HTTP',
          noSse: 'Streamable HTTP failed, not trying SSE fallback',
          trySse: 'Streamable HTTP failed, trying SSE fallback',
          sseOk: 'Connected to remote MCP server via SSE',
        };

  try {
    const httpTransport = new StreamableHTTPClientTransport(remoteUrl, {
      authProvider,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    await client.connect(httpTransport);
    logger.info(msgs.streamableOk, meta);
  } catch (httpErr) {
    const detail = errorDetail(httpErr);
    const category = classifyError(httpErr);
    if (!shouldFallbackToSse(httpErr)) {
      logger.warn(msgs.noSse, { category, error: detail });
      throw httpErr;
    }
    logger.warn(msgs.trySse, { category, error: detail });
    const sseTransport = new SSEClientTransport(remoteUrl, { authProvider });
    await client.connect(sseTransport);
    logger.info(msgs.sseOk, meta);
  }
}

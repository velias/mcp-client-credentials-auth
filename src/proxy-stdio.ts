import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { ProxyHandle } from './proxy-handle.js';
import { createProxySession } from './proxy-session.js';
import { discoverRemoteMcp } from './remote-mcp-discovery.js';
import type { TokenManager } from './token-manager.js';

export async function createStdioProxy(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
  /** Absolute deadline (Date.now()-based) for Phase 1 remote readiness; defaults to now + startupTimeoutMs. */
  startupDeadlineMs: number = Date.now() + config.startupTimeoutMs,
): Promise<ProxyHandle> {
  const discovery = await discoverRemoteMcp(config, tokenManager, logger, startupDeadlineMs);

  const session = createProxySession(config, tokenManager, logger, {
    discoveredCapabilities: discovery.capabilities,
    remoteServerInfo: discovery.serverInfo,
    onLocalDisconnect: 'exit',
  });

  const stdioTransport = new StdioServerTransport();
  await session.localServer.connect(stdioTransport);
  logger.info('Local MCP server started on stdio');

  return {
    async close() {
      logger.info('Shutting down proxy');
      await session.close();
    },
  };
}

#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTokenManager } from './token-manager.js';
import { createHttpProxy } from './proxy-http.js';
import { createStdioProxy } from './proxy-stdio.js';
import { PKG_VERSION } from './proxy-utils.js';
import type { ProxyHandle } from './proxy-handle.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.debug);

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    logger.warn(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 detected -- TLS certificate validation is disabled. This undermines transport security.',
    );
  }

  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

  const remoteUrl = new URL(config.remoteMcpUrl);
  if (remoteUrl.protocol === 'http:' && !loopbackHosts.includes(remoteUrl.hostname)) {
    logger.warn(
      'Remote MCP Server URL uses cleartext HTTP to a non-loopback host. Access token will travel unencrypted!',
      { url: config.remoteMcpUrl },
    );
  }

  if (config.tokenEndpoint) {
    const tokenUrl = new URL(config.tokenEndpoint);
    if (tokenUrl.protocol === 'http:' && !loopbackHosts.includes(tokenUrl.hostname)) {
      logger.warn(
        'Token endpoint URL uses cleartext HTTP to a non-loopback host. Client secret will travel unencrypted!',
        { url: config.tokenEndpoint },
      );
    }
  }

  const tokenManager = createTokenManager(config, logger);

  logger.info(`Starting mcp-client-credentials-auth proxy v${PKG_VERSION}`, {
    remote: config.remoteMcpUrl,
    clientId: config.clientId,
    transport: config.transport,
    ...(config.transport === 'http'
      ? {
          listenHost: config.listenHost,
          listenPort: config.listenPort,
          listenPath: config.listenPath,
          httpSessionIdleSeconds: config.httpSessionIdleSeconds,
        }
      : {}),
    oauthRediscoverySeconds: config.oauthRediscoverySeconds,
    refreshSkewSeconds: config.refreshSkewSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    startupTimeoutMs: config.startupTimeoutMs,
    capabilitiesPollSeconds: config.capabilitiesPollSeconds,
    debug: config.debug,
  });

  const startupDeadlineMs = Date.now() + config.startupTimeoutMs;

  try {
    await tokenManager.waitUntilAuthReady(startupDeadlineMs);
  } catch (err) {
    logger.error('Startup auth readiness failed', {
      category: 'authentication',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  let proxy: ProxyHandle;
  try {
    proxy =
      config.transport === 'http'
        ? await createHttpProxy(config, tokenManager, logger, startupDeadlineMs)
        : await createStdioProxy(config, tokenManager, logger, startupDeadlineMs);
  } catch (err) {
    logger.error('Failed to start proxy', {
      category: 'connection',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    tokenManager.stop();
    await proxy.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: mcp-client-credentials-auth: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

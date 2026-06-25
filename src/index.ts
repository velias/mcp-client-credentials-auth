#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTokenManager } from './token-manager.js';
import { createProxy, PKG_VERSION, type ProxyHandle } from './proxy.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.debug);

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    logger.warn(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 detected -- TLS certificate validation is disabled. This undermines transport security.',
    );
  }

  const remoteUrl = new URL(config.remoteMcpUrl);
  if (
    remoteUrl.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(remoteUrl.hostname)
  ) {
    logger.warn(
      'Remote MCP Server URL uses cleartext HTTP to a non-loopback host. Access token will travel unencrypted!',
      { url: config.remoteMcpUrl },
    );
  }

  const tokenManager = createTokenManager(config, logger);

  logger.info(`Starting mcp-client-credentials-auth proxy v${PKG_VERSION}`, {
    remote: config.remoteMcpUrl,
    clientId: config.clientId,
    refreshSkewSeconds: config.refreshSkewSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    capabilitiesPollSeconds: config.capabilitiesPollSeconds,
    debug: config.debug,
  });

  try {
    await tokenManager.discover();
  } catch (err) {
    logger.warn('Initial OAuth discovery failed (will retry on first request)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const authMode = tokenManager.getAuthMode();
  if (authMode.type === 'authenticated') {
    try {
      await tokenManager.prefetch();
    } catch (err) {
      logger.warn('Token prefetch failed (will retry on first request)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let proxy: ProxyHandle;
  try {
    proxy = await createProxy(config, tokenManager, logger);
  } catch (err) {
    logger.error('Failed to start proxy', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    await proxy.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

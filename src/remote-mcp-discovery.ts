import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { getBackoffDelay, sleep } from './backoff.js';
import type { Config } from './config.js';
import {
  PROXY_NAME,
  classifyError,
  errorDetail,
  formatUnrecoverableOAuthMisconfig,
  resolveUnrecoverableStartupAuthSource,
} from './errors.js';
import type { Logger } from './logger.js';
import { connectWithTransportFallback } from './remote-connect.js';
import type { TokenManager } from './token-manager.js';
import { PKG_VERSION, withClientCredentialsExtension } from './proxy-utils.js';

export interface RemoteMcpDiscoveryResult {
  capabilities: ServerCapabilities;
  serverInfo: Implementation | undefined;
}

const PHASE1_RETRY_BASE_MS = 1000;
const PHASE1_RETRY_MAX_MS = 60000;

/**
 * Phase 1: Required discovery connection (retry until shared startup deadline).
 * Proves remote reachability and reads server info/capabilities before local bind.
 */
export async function discoverRemoteMcp(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
  startupDeadlineMs: number,
): Promise<RemoteMcpDiscoveryResult> {
  const remoteUrl = new URL(config.remoteMcpUrl);

  async function connectDiscoveryClient(): Promise<RemoteMcpDiscoveryResult> {
    const discoveryClient = new Client(
      { name: PROXY_NAME, version: PKG_VERSION },
      { capabilities: withClientCredentialsExtension({}) },
    );

    await connectWithTransportFallback(discoveryClient, remoteUrl, {
      authProvider: tokenManager.getAuthProvider(),
      fetch: tokenManager.getScopeStepUpFetch(),
      logger,
      phase: 'discovery',
    });

    const capabilities = discoveryClient.getServerCapabilities() ?? {};
    const serverInfo = discoveryClient.getServerVersion();
    await discoveryClient.close();
    logger.debug('Discovery connection closed');
    return { capabilities, serverInfo };
  }

  let phase1Attempt = 0;
  while (true) {
    logger.info('Connecting to remote MCP server for discovery', {
      url: config.remoteMcpUrl,
      attempt: phase1Attempt + 1,
    });
    try {
      return await connectDiscoveryClient();
    } catch (err) {
      const detail = errorDetail(err);
      const category = classifyError(err);
      const authFailureSource = resolveUnrecoverableStartupAuthSource(err);
      if (authFailureSource) {
        const message = formatUnrecoverableOAuthMisconfig(detail, authFailureSource);
        logger.error(message, {
          category: 'authentication',
          unrecoverable: true,
          failureSource: authFailureSource,
          error: detail,
        });
        throw new Error(message, { cause: err });
      }
      const remaining = startupDeadlineMs - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Remote MCP server unreachable within startup timeout: ${detail}`,
          { cause: err },
        );
      }
      const delayMs = Math.min(
        getBackoffDelay(phase1Attempt, PHASE1_RETRY_BASE_MS, PHASE1_RETRY_MAX_MS),
        remaining,
      );
      logger.warn('Remote MCP server unreachable during discovery, retrying', {
        category,
        error: detail,
        attempt: phase1Attempt + 1,
        delayMs,
        remainingMs: remaining,
      });
      await sleep(delayMs);
      phase1Attempt++;
    }
  }
}

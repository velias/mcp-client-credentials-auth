import {
  auth,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface TokenRefreshController {
  installRefreshHook(provider: ClientCredentialsProvider): void;
  scheduleRefresh(expiresIn?: number): void;
  cancelRefreshTimer(): void;
  /** Shared flight with TokenManager acquire coalesce when provided. */
  setAcquireFn(fn: () => Promise<void>): void;
}

export function createTokenRefreshController(
  config: Config,
  logger: Logger,
  getProvider: () => ClientCredentialsProvider | undefined,
  timeoutFetch: typeof globalThis.fetch,
): TokenRefreshController {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inflightRefresh: Promise<void> | undefined;
  let acquireFn: (() => Promise<void>) | undefined;

  const MAX_REFRESH_RETRIES = 3;
  let refreshRetryCount = 0;
  let extendedRefreshAttempt = 0;
  const EXTENDED_REFRESH_BASE_MS = 30_000;
  const EXTENDED_REFRESH_MAX_MS = 300_000;

  function cancelRefreshTimer(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function scheduleRefresh(expiresIn?: number): void {
    cancelRefreshTimer();
    if (!expiresIn || expiresIn <= 0) return;

    const refreshInMs = Math.max((expiresIn - config.refreshSkewSeconds) * 1000, 1000);
    refreshTimer = setTimeout(() => void doProactiveRefresh(), refreshInMs);
    logger.debug('Proactive token refresh scheduled', {
      expiresInSeconds: expiresIn,
      refreshInSeconds: Math.round(refreshInMs / 1000),
    });
  }

  function installRefreshHook(p: ClientCredentialsProvider): void {
    const originalSaveTokens = p.saveTokens.bind(p);
    p.saveTokens = (tokens: OAuthTokens) => {
      originalSaveTokens(tokens);
      scheduleRefresh(tokens.expires_in);
    };
  }

  function getRetryIntervalMs(): number {
    const skewMs = config.refreshSkewSeconds * 1000;
    return Math.max(Math.min(5_000, Math.floor(skewMs / (MAX_REFRESH_RETRIES + 1))), 500);
  }

  function getExtendedRetryDelay(): number {
    const exponential = Math.min(
      EXTENDED_REFRESH_BASE_MS * 2 ** extendedRefreshAttempt,
      EXTENDED_REFRESH_MAX_MS,
    );
    const jitter = Math.random() * exponential * 0.2;
    return Math.round(exponential + jitter);
  }

  async function performRefresh(): Promise<void> {
    const provider = getProvider();
    if (!provider) return;
    logger.debug('Starting proactive token refresh');
    try {
      if (acquireFn) {
        await acquireFn();
      } else {
        const result = await auth(provider, {
          serverUrl: config.remoteMcpUrl,
          fetchFn: timeoutFetch,
        });
        if (result !== 'AUTHORIZED') {
          throw new Error('Proactive token refresh did not authorize');
        }
      }
      logger.info('Proactive token refresh successful');
      refreshRetryCount = 0;
      extendedRefreshAttempt = 0;
    } catch (err) {
      refreshRetryCount++;
      if (refreshRetryCount < MAX_REFRESH_RETRIES) {
        const retryMs = getRetryIntervalMs();
        logger.warn('Proactive token refresh failed, scheduling retry', {
          category: 'authentication',
          error: err instanceof Error ? err.message : String(err),
          attempt: refreshRetryCount,
          maxAttempts: MAX_REFRESH_RETRIES,
          retryInMs: retryMs,
        });
        refreshTimer = setTimeout(() => void doProactiveRefresh(), retryMs);
      } else {
        const extendedDelayMs = getExtendedRetryDelay();
        logger.warn(
          'Proactive token refresh exhausted fast retries, switching to extended backoff',
          {
            category: 'authentication',
            error: err instanceof Error ? err.message : String(err),
            attempts: refreshRetryCount,
            nextRetryMs: extendedDelayMs,
          },
        );
        refreshRetryCount = 0;
        extendedRefreshAttempt++;
        refreshTimer = setTimeout(() => void doProactiveRefresh(), extendedDelayMs);
      }
    }
  }

  async function doProactiveRefresh(): Promise<void> {
    if (inflightRefresh) return;
    inflightRefresh = performRefresh().finally(() => {
      inflightRefresh = undefined;
    });
    await inflightRefresh;
  }

  return {
    installRefreshHook,
    scheduleRefresh,
    cancelRefreshTimer,
    setAcquireFn(fn: () => Promise<void>) {
      acquireFn = fn;
    },
  };
}

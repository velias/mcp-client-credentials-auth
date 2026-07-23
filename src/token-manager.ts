import {
  auth as sdkAuthFn,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as sdkAuth from '@modelcontextprotocol/sdk/client/auth.js';
import { getBackoffDelay, sleep } from './backoff.js';
import type { Config } from './config.js';
import {
  errorDetail,
  formatProxyError,
  formatUnrecoverableOAuthMisconfig,
  isPermanentOAuthConfigError,
} from './errors.js';
import type { Logger } from './logger.js';
import {
  type AuthMode,
  type OAuthDiscoverySnapshot,
  describeSignificantOAuthChanges,
  discoverOAuthForRemote,
  isSignificantOAuthChange,
} from './remote-oauth-discovery.js';
import { createScopeStepUpFetch, mergeOAuthScopes } from './scope-step-up.js';
import { createTokenRefreshController } from './token-refresh.js';

export type { AuthMode } from './remote-oauth-discovery.js';

export interface TokenManager {
  discover(): Promise<void>;
  prefetch(): Promise<void>;
  waitUntilAuthReady(deadlineMs: number): Promise<void>;
  hasUsableAccessToken(): boolean;
  getAuthProvider(): OAuthClientProvider | undefined;
  getAuthMode(): AuthMode;
  getAccessToken(): string | undefined;
  getCurrentScopes(): string | undefined;
  stepUpScopes(challengeScopes: string): Promise<void>;
  getScopeStepUpFetch(): FetchLike;
  rediscoverOAuthMetadata(): Promise<void>;
  invalidate(): void;
  stop(): void;
}

const AUTH_RETRY_BASE_MS = 5000;
const AUTH_RETRY_MAX_MS = 60000;

/** Sentinel used to clear a cached access token without removing the provider. */
const CLEAR_TOKENS: OAuthTokens = { access_token: '', token_type: 'bearer' };

/** Unpatched SDK auth; used by acquire so the module export patch cannot recurse. */
const originalSdkAuth = sdkAuthFn;

export function createTokenManager(config: Config, logger: Logger): TokenManager {
  let authMode: AuthMode = {
    type: 'discovery-failed',
    message: formatProxyError('authentication', 'Discovery not attempted yet'),
  };
  let provider: ClientCredentialsProvider | undefined;
  let currentScopes: string | undefined;
  let discoverySnapshot: OAuthDiscoverySnapshot | undefined;
  let inflightStepUp: Promise<void> | undefined;
  let inflightAcquire: Promise<void> | undefined;
  let inflightRediscovery: Promise<void> | undefined;
  let rediscoveryTimer: ReturnType<typeof setInterval> | undefined;
  let authPatchInstalled = false;

  const timeoutFetch: typeof globalThis.fetch = (input, init) => {
    const signal = config.requestTimeoutMs
      ? AbortSignal.timeout(config.requestTimeoutMs)
      : undefined;
    return fetch(input, { ...init, signal });
  };

  const refresh = createTokenRefreshController(
    config,
    logger,
    () => provider,
    timeoutFetch,
  );

  function createAuthenticatedProvider(scopes: string | undefined): ClientCredentialsProvider {
    const p = new ClientCredentialsProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(scopes ? { scope: scopes } : {}),
    });
    refresh.installRefreshHook(p);
    return p;
  }

  function applyDiscoveryResult(result: Awaited<ReturnType<typeof discoverOAuthForRemote>>): void {
    authMode = result.authMode;
    provider = result.provider;
    currentScopes = result.currentScopes;
    discoverySnapshot = result.snapshot;
  }

  async function discover(): Promise<void> {
    const result = await discoverOAuthForRemote(
      config,
      logger,
      timeoutFetch,
      createAuthenticatedProvider,
    );
    applyDiscoveryResult(result);
  }

  /**
   * Coalesce concurrent auth()/token acquires for the shared provider (prefetch, refresh,
   * step-up, rediscovery, and SDK 401→auth() across multi-session clients).
   */
  async function acquireAccessToken(
    options?: Parameters<typeof originalSdkAuth>[1],
  ): Promise<void> {
    if (inflightAcquire) {
      await inflightAcquire;
      return;
    }
    if (!provider || authMode.type !== 'authenticated') {
      return;
    }
    const p = provider;
    inflightAcquire = (async () => {
      const result = await originalSdkAuth(p, {
        serverUrl: config.remoteMcpUrl,
        fetchFn: timeoutFetch,
        ...options,
      });
      if (result !== 'AUTHORIZED') {
        throw new Error(formatProxyError('authentication', 'Token acquisition did not authorize'));
      }
    })().finally(() => {
      inflightAcquire = undefined;
    });
    await inflightAcquire;
  }

  refresh.setAcquireFn(() => acquireAccessToken());

  function installSdkAuthCoalesce(): void {
    if (authPatchInstalled) return;
    authPatchInstalled = true;
    // CJS transports look up auth on the module exports object each call.
    (sdkAuth as { auth: typeof originalSdkAuth }).auth = async (p, options) => {
      if (provider && p === provider) {
        await acquireAccessToken(options);
        return 'AUTHORIZED';
      }
      return originalSdkAuth(p, options);
    };
  }

  installSdkAuthCoalesce();

  async function prefetch(): Promise<void> {
    if (authMode.type !== 'authenticated' || !provider) {
      return;
    }
    try {
      await acquireAccessToken();
      logger.info('Token prefetch successful');
    } catch (err) {
      const message = errorDetail(err);
      logger.warn('Token prefetch failed', {
        category: 'authentication',
        error: message,
      });
      if (isPermanentOAuthConfigError(err)) {
        throw err;
      }
    }
  }

  function hasUsableAccessToken(): boolean {
    if (authMode.type !== 'authenticated' || !provider) {
      return false;
    }
    const tokens = provider.tokens();
    return typeof tokens?.access_token === 'string' && tokens.access_token.length > 0;
  }

  function getAccessToken(): string | undefined {
    if (authMode.type !== 'authenticated' || !provider) {
      return undefined;
    }
    const token = provider.tokens()?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  function getCurrentScopes(): string | undefined {
    return currentScopes;
  }

  function snapshotTokens(tokens: OAuthTokens | undefined): OAuthTokens | undefined {
    return tokens ? { ...tokens } : undefined;
  }

  function restoreScopesAndTokens(
    scopes: string | undefined,
    tokens: OAuthTokens | undefined,
  ): void {
    currentScopes = scopes;
    if (!provider) return;
    provider.clientMetadata.scope = scopes;
    // Restore the prior token (or clear) so a failed step-up cannot leave auth unusable.
    provider.saveTokens(tokens && tokens.access_token ? tokens : CLEAR_TOKENS);
  }

  /**
   * Accumulate challenge scopes into the live provider metadata and acquire a new token.
   * Concurrent callers share one in-flight acquisition; scopes merged during the flight
   * trigger another auth pass so the final token includes the full union.
   *
   * Scopes/tokens commit only after a successful auth(). On failure, the pre-flight
   * baseline is restored so a bad insufficient_scope challenge cannot poison scopes
   * or wipe a working access token.
   */
  async function stepUpScopes(challengeScopes: string): Promise<void> {
    if (authMode.type !== 'authenticated' || !provider) {
      throw new Error(
        formatProxyError('authentication', 'Cannot step up scopes: proxy is not authenticated'),
      );
    }

    const startingNewFlight = !inflightStepUp;
    const baselineScopes = startingNewFlight ? currentScopes : undefined;
    const baselineTokens = startingNewFlight ? snapshotTokens(provider.tokens()) : undefined;

    currentScopes = mergeOAuthScopes(currentScopes, challengeScopes);

    if (startingNewFlight) {
      inflightStepUp = (async () => {
        try {
          let scopesSnapshot: string | undefined;
          do {
            if (!provider) {
              throw new Error(
                formatProxyError('authentication', 'Cannot step up scopes: provider missing'),
              );
            }
            scopesSnapshot = currentScopes;
            provider.clientMetadata.scope = scopesSnapshot;
            // Clear the cached token so auth() fetches with the updated clientMetadata.scope.
            provider.saveTokens(CLEAR_TOKENS);
            try {
              await acquireAccessToken();
            } catch (err) {
              restoreScopesAndTokens(baselineScopes, baselineTokens);
              throw err;
            }
          } while (scopesSnapshot !== currentScopes);
        } finally {
          inflightStepUp = undefined;
        }
      })();
    }

    await inflightStepUp;
  }

  function getScopeStepUpFetch(): FetchLike {
    if (authMode.type !== 'authenticated' || !provider) {
      return fetch;
    }
    return createScopeStepUpFetch({
      // Use global fetch (not timeoutFetch): Streamable HTTP also uses this for long-lived SSE.
      getAccessToken,
      getCurrentScopes,
      stepUp: stepUpScopes,
      logger,
    });
  }

  function startRediscoverySchedule(): void {
    if (rediscoveryTimer) return;
    if (config.tokenEndpoint) return;
    if (config.oauthRediscoverySeconds <= 0) return;

    const intervalMs = config.oauthRediscoverySeconds * 1000;
    rediscoveryTimer = setInterval(() => {
      void rediscoverOAuthMetadata();
    }, intervalMs);
    // Allow the process to exit naturally in tests / short-lived runs.
    rediscoveryTimer.unref?.();
    logger.info('OAuth rediscovery schedule started', {
      intervalSeconds: config.oauthRediscoverySeconds,
    });
  }

  function stopRediscoverySchedule(): void {
    if (rediscoveryTimer) {
      clearInterval(rediscoveryTimer);
      rediscoveryTimer = undefined;
    }
  }

  async function rediscoverOAuthMetadata(): Promise<void> {
    if (config.tokenEndpoint) {
      logger.debug('Skipping OAuth rediscovery (manual token endpoint configured)');
      return;
    }
    if (inflightRediscovery) {
      await inflightRediscovery;
      return;
    }

    inflightRediscovery = (async () => {
      logger.debug('Starting OAuth rediscovery');
      const previousSnapshot = discoverySnapshot;
      const previousProvider = provider;
      const previousScopes = currentScopes;
      const previousMode = authMode;
      const previousTokens = previousProvider
        ? snapshotTokens(previousProvider.tokens())
        : undefined;

      let result: Awaited<ReturnType<typeof discoverOAuthForRemote>>;
      try {
        result = await discoverOAuthForRemote(
          config,
          logger,
          timeoutFetch,
          createAuthenticatedProvider,
        );
      } catch (err) {
        logger.warn('OAuth rediscovery failed; keeping previous discovery and token', {
          category: 'authentication',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Dual well-known failure surfaces as discovery-failed; do not brick a working token.
      if (
        result.authMode.type === 'discovery-failed' &&
        previousSnapshot &&
        previousSnapshot.authModeType !== 'discovery-failed'
      ) {
        logger.warn('OAuth rediscovery failed; keeping previous discovery and token', {
          category: 'authentication',
          error: result.authMode.message,
        });
        return;
      }

      // Partial failure (e.g. PRM ok, AS .well-known down) is reported as no-auth at discovery
      // time. At runtime that must not downgrade an authenticated process and clear token gating.
      if (result.authMode.type === 'no-auth' && previousMode.type === 'authenticated') {
        logger.warn(
          'OAuth rediscovery reported no-auth while previously authenticated; keeping previous discovery and token',
          { category: 'authentication' },
        );
        return;
      }

      if (!previousSnapshot || !isSignificantOAuthChange(previousSnapshot, result.snapshot)) {
        // Keep current provider/token; discard the freshly built provider from rediscovery.
        logger.info('OAuth rediscovery unchanged');
        // Reset timer cadence after a successful pass.
        stopRediscoverySchedule();
        startRediscoverySchedule();
        return;
      }

      const changes = describeSignificantOAuthChanges(previousSnapshot, result.snapshot);
      logger.info('OAuth rediscovery detected significant change; reacquiring token', {
        changes,
      });

      refresh.cancelRefreshTimer();
      applyDiscoveryResult(result);

      if (authMode.type === 'authenticated') {
        try {
          await acquireAccessToken();
          logger.info('Token reacquired after OAuth rediscovery');
        } catch (err) {
          logger.warn('Token reacquire after OAuth rediscovery failed', {
            category: 'authentication',
            error: errorDetail(err),
          });
          // Leave auth gap behavior to runtime request gating / proactive refresh.
        }
      } else if (
        previousMode.type === 'authenticated' &&
        previousProvider &&
        previousTokens?.access_token
      ) {
        // Mode flipped away from authenticated; drop the old token.
        void previousScopes;
        previousProvider.saveTokens(CLEAR_TOKENS);
      }

      stopRediscoverySchedule();
      startRediscoverySchedule();
    })().finally(() => {
      inflightRediscovery = undefined;
    });

    await inflightRediscovery;
  }

  async function waitUntilAuthReady(deadlineMs: number): Promise<void> {
    let attempt = 0;
    while (true) {
      await discover();
      const mode = authMode;

      if (mode.type === 'unsupported-grant') {
        throw new Error(mode.message);
      }

      if (mode.type === 'no-auth') {
        logger.info('Auth readiness: no-auth mode (token not required)');
        startRediscoverySchedule();
        return;
      }

      if (mode.type === 'authenticated') {
        try {
          await prefetch();
        } catch (err) {
          if (isPermanentOAuthConfigError(err)) {
            const message = formatUnrecoverableOAuthMisconfig(errorDetail(err), 'idp');
            logger.error(message, {
              category: 'authentication',
              unrecoverable: true,
              failureSource: 'idp',
              error: errorDetail(err),
            });
            throw new Error(message, { cause: err });
          }
          // Transient prefetch failure: fall through to deadline/retry below.
        }
        if (hasUsableAccessToken()) {
          logger.info('Auth readiness: usable access token acquired');
          startRediscoverySchedule();
          return;
        }
      }

      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        const detail =
          mode.type === 'discovery-failed'
            ? 'OAuth discovery did not succeed within startup timeout'
            : 'No usable access token within startup timeout';
        throw new Error(formatProxyError('authentication', detail));
      }

      const delayMs = Math.min(
        getBackoffDelay(attempt, AUTH_RETRY_BASE_MS, AUTH_RETRY_MAX_MS),
        remaining,
      );
      logger.info('Auth not ready, retrying before startup deadline', {
        category: 'authentication',
        authMode: mode.type,
        attempt: attempt + 1,
        delayMs,
        remainingMs: remaining,
      });
      await sleep(delayMs);
      attempt++;
    }
  }

  function invalidate(): void {
    refresh.cancelRefreshTimer();
    if (provider) {
      provider.saveTokens(CLEAR_TOKENS);
    }
  }

  function stop(): void {
    refresh.cancelRefreshTimer();
    stopRediscoverySchedule();
  }

  function getAuthProvider(): OAuthClientProvider | undefined {
    if (authMode.type === 'authenticated') {
      return provider;
    }
    return undefined;
  }

  function getAuthMode(): AuthMode {
    return authMode;
  }

  return {
    discover,
    prefetch,
    waitUntilAuthReady,
    hasUsableAccessToken,
    getAuthProvider,
    getAuthMode,
    getAccessToken,
    getCurrentScopes,
    stepUpScopes,
    getScopeStepUpFetch,
    rediscoverOAuthMetadata,
    invalidate,
    stop,
  };
}

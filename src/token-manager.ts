import {
  ClientCredentialsProvider,
} from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthProtectedResourceMetadata,
  OAuthTokens,
  AuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from './config.js';
import { formatProxyError } from './errors.js';
import type { Logger } from './logger.js';

export type AuthMode =
  | { type: 'authenticated'; provider: ClientCredentialsProvider }
  | { type: 'no-auth' }
  | { type: 'unsupported-grant'; message: string }
  | { type: 'discovery-failed'; message: string };

export interface TokenManager {
  discover(): Promise<void>;
  prefetch(): Promise<void>;
  getAuthProvider(): OAuthClientProvider | undefined;
  getAuthMode(): AuthMode;
  invalidate(): void;
  stop(): void;
}

const REDISCOVERY_BASE_MS = 5000;
const REDISCOVERY_MAX_MS = 60000;

function getBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential + jitter);
}

function seedManualDiscoveryState(
  provider: ClientCredentialsProvider,
  tokenEndpoint: string,
  remoteMcpUrl: string,
): void {
  const issuer = new URL(tokenEndpoint).origin;
  let discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl: issuer,
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: tokenEndpoint,
      token_endpoint: tokenEndpoint,
      response_types_supported: [],
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    },
    resourceMetadata: { resource: remoteMcpUrl },
  };

  // ClientCredentialsProvider does not declare these optional OAuthClientProvider hooks;
  // assign them so auth() skips RFC 9728 / AS rediscovery and omits the resource param.
  const extensible = provider as ClientCredentialsProvider & OAuthClientProvider;
  extensible.discoveryState = () => discoveryState;
  extensible.saveDiscoveryState = (state: OAuthDiscoveryState) => {
    discoveryState = state;
  };
  extensible.validateResourceURL = () => Promise.resolve(undefined);
}

export function createTokenManager(config: Config, logger: Logger): TokenManager {
  let authMode: AuthMode = {
    type: 'discovery-failed',
    message: formatProxyError('authentication', 'Discovery not attempted yet'),
  };
  let provider: ClientCredentialsProvider | undefined;
  let currentScopes: string | undefined;
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authServerMetadata: AuthorizationServerMetadata | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inflightRefresh: Promise<void> | undefined;
  let rediscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let rediscoveryAttempt = 0;
  let prefetchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchRetryAttempt = 0;

  const timeoutFetch: typeof globalThis.fetch = (input, init) => {
    const signal = config.requestTimeoutMs
      ? AbortSignal.timeout(config.requestTimeoutMs)
      : undefined;
    return fetch(input, { ...init, signal });
  };

  function clearPrefetchRetry(): void {
    if (prefetchRetryTimer) {
      clearTimeout(prefetchRetryTimer);
      prefetchRetryTimer = undefined;
    }
    prefetchRetryAttempt = 0;
  }

  function schedulePrefetchRetry(): void {
    if (prefetchRetryTimer || !config.tokenEndpoint) return;
    const delayMs = getBackoffDelay(prefetchRetryAttempt, REDISCOVERY_BASE_MS, REDISCOVERY_MAX_MS);
    logger.info('Scheduling token prefetch retry', {
      attempt: prefetchRetryAttempt + 1,
      delayMs,
    });
    prefetchRetryTimer = setTimeout(() => {
      prefetchRetryTimer = undefined;
      prefetchRetryAttempt++;
      void prefetch();
    }, delayMs);
  }

  function scheduleRediscovery(): void {
    if (rediscoveryTimer) return;
    const delayMs = getBackoffDelay(rediscoveryAttempt, REDISCOVERY_BASE_MS, REDISCOVERY_MAX_MS);
    logger.info('Scheduling OAuth re-discovery', {
      attempt: rediscoveryAttempt + 1,
      delayMs,
    });
    rediscoveryTimer = setTimeout(() => {
      rediscoveryTimer = undefined;
      void performRediscovery();
    }, delayMs);
  }

  async function performRediscovery(): Promise<void> {
    rediscoveryAttempt++;
    logger.info('Starting OAuth re-discovery', { attempt: rediscoveryAttempt });
    try {
      await discover();
      if (authMode.type === 'authenticated') {
        logger.info('OAuth re-discovery succeeded, attempting token prefetch');
        await prefetch();
      }
    } catch (err) {
      logger.warn('OAuth re-discovery failed', {
        category: 'authentication',
        error: err instanceof Error ? err.message : String(err),
        attempt: rediscoveryAttempt,
      });
    }
    if (authMode.type === 'discovery-failed') {
      scheduleRediscovery();
    }
  }

  function createAuthenticatedProvider(scopes: string | undefined): ClientCredentialsProvider {
    const p = new ClientCredentialsProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(scopes ? { scope: scopes } : {}),
    });
    installRefreshHook(p);
    return p;
  }

  function setupManualTokenEndpoint(): void {
    const tokenEndpoint = config.tokenEndpoint!;
    if (config.scopes) {
      currentScopes = config.scopes;
      logger.info('Using scopes from MCP_CC_PROXY_SCOPES', {
        scopes: currentScopes,
      });
    } else {
      currentScopes = undefined;
    }

    provider = createAuthenticatedProvider(currentScopes);
    seedManualDiscoveryState(provider, tokenEndpoint, config.remoteMcpUrl);

    authMode = { type: 'authenticated', provider };
    logger.info('Using manual token endpoint (skipping OAuth discovery)', {
      tokenEndpoint,
      scopes: currentScopes ?? '(none)',
    });
  }

  async function discover(): Promise<void> {
    if (config.tokenEndpoint) {
      setupManualTokenEndpoint();
      return;
    }

    const serverUrl = config.remoteMcpUrl;
    logger.info('Starting OAuth discovery', { serverUrl });

    let resourceDiscoveryFailed = false;
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, timeoutFetch);
    } catch {
      logger.debug('RFC 9728 protected resource metadata not found, trying AS discovery on server URL');
      resourceMetadata = undefined;
      resourceDiscoveryFailed = true;
    }

    const authServerUrl = resourceMetadata?.authorization_servers?.[0] ?? serverUrl;
    logger.debug('Starting authorization server discovery', { authServerUrl });

    let asDiscoveryFailed = false;
    try {
      authServerMetadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: timeoutFetch });
    } catch (err) {
      logger.debug('Authorization server discovery failed', {
        authServerUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      authServerMetadata = undefined;
      asDiscoveryFailed = true;
    }

    if (!authServerMetadata) {
      if (resourceDiscoveryFailed && asDiscoveryFailed) {
        const detail =
          'OAuth discovery failed (both resource and authorization server endpoints unreachable). Requests will be rejected until discovery succeeds.';
        const msg = formatProxyError('authentication', detail);
        logger.warn(msg, { category: 'authentication' });
        authMode = { type: 'discovery-failed', message: msg };
        scheduleRediscovery();
        return;
      }

      logger.warn(
        'Remote server does not announce auth requirements -- proxying without authentication',
      );
      authMode = { type: 'no-auth' };
      rediscoveryAttempt = 0;
      return;
    }

    const grantTypes = authServerMetadata.grant_types_supported ?? ['authorization_code'];
    if (!grantTypes.includes('client_credentials')) {
      const detail =
        `Remote MCP server requires authentication but its IdP does not support client_credentials grant. ` +
        `Supported grants: [${grantTypes.join(', ')}]. This proxy only supports client_credentials.`;
      const msg = formatProxyError('authentication', detail);
      logger.error(msg, { category: 'authentication' });
      authMode = { type: 'unsupported-grant', message: msg };
      return;
    }

    if (config.scopes) {
      currentScopes = config.scopes;
      logger.info('Using scopes from MCP_CC_PROXY_SCOPES (overriding discovery)', {
        scopes: currentScopes,
      });
    } else if (resourceMetadata?.scopes_supported?.length) {
      currentScopes = resourceMetadata.scopes_supported.join(' ');
    }

    provider = createAuthenticatedProvider(currentScopes);

    authMode = { type: 'authenticated', provider };
    rediscoveryAttempt = 0;
    logger.info('OAuth discovery complete', {
      tokenEndpoint: authServerMetadata.token_endpoint,
      scopes: currentScopes ?? '(default)',
    });
  }

  function installRefreshHook(p: ClientCredentialsProvider): void {
    const originalSaveTokens = p.saveTokens.bind(p);
    p.saveTokens = (tokens: OAuthTokens) => {
      originalSaveTokens(tokens);
      scheduleRefresh(tokens.expires_in);
    };
  }

  function scheduleRefresh(expiresIn?: number): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (!expiresIn || expiresIn <= 0) return;

    const refreshInMs = Math.max((expiresIn - config.refreshSkewSeconds) * 1000, 1000);
    refreshTimer = setTimeout(() => void doProactiveRefresh(), refreshInMs);
    logger.debug('Proactive token refresh scheduled', {
      expiresInSeconds: expiresIn,
      refreshInSeconds: Math.round(refreshInMs / 1000),
    });
  }

  async function doProactiveRefresh(): Promise<void> {
    if (inflightRefresh) return;
    inflightRefresh = performRefresh().finally(() => { inflightRefresh = undefined; });
    await inflightRefresh;
  }

  const MAX_REFRESH_RETRIES = 3;
  let refreshRetryCount = 0;
  let extendedRefreshAttempt = 0;
  const EXTENDED_REFRESH_BASE_MS = 30_000;
  const EXTENDED_REFRESH_MAX_MS = 300_000;

  function getRetryIntervalMs(): number {
    const skewMs = config.refreshSkewSeconds * 1000;
    return Math.max(Math.min(5_000, Math.floor(skewMs / (MAX_REFRESH_RETRIES + 1))), 500);
  }

  function getExtendedRetryDelay(): number {
    const exponential = Math.min(EXTENDED_REFRESH_BASE_MS * 2 ** extendedRefreshAttempt, EXTENDED_REFRESH_MAX_MS);
    const jitter = Math.random() * exponential * 0.2;
    return Math.round(exponential + jitter);
  }

  async function performRefresh(): Promise<void> {
    if (!provider) return;
    logger.debug('Starting proactive token refresh');
    try {
      const result = await auth(provider, { serverUrl: config.remoteMcpUrl, fetchFn: timeoutFetch });
      if (result === 'AUTHORIZED') {
        logger.info('Proactive token refresh successful');
        refreshRetryCount = 0;
        extendedRefreshAttempt = 0;
      }
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
        logger.warn('Proactive token refresh exhausted fast retries, switching to extended backoff', {
          category: 'authentication',
          error: err instanceof Error ? err.message : String(err),
          attempts: refreshRetryCount,
          nextRetryMs: extendedDelayMs,
        });
        refreshRetryCount = 0;
        extendedRefreshAttempt++;
        refreshTimer = setTimeout(() => void doProactiveRefresh(), extendedDelayMs);
      }
    }
  }

  async function prefetch(): Promise<void> {
    if (authMode.type !== 'authenticated' || !provider) {
      return;
    }
    try {
      const result = await auth(provider, { serverUrl: config.remoteMcpUrl, fetchFn: timeoutFetch });
      if (result === 'AUTHORIZED') {
        logger.info('Token prefetch successful');
        clearPrefetchRetry();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Token prefetch failed (will retry on first request)', {
        category: 'authentication',
        error: message,
      });
      if (config.tokenEndpoint) {
        schedulePrefetchRetry();
      }
    }
  }

  function invalidate(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (rediscoveryTimer) {
      clearTimeout(rediscoveryTimer);
      rediscoveryTimer = undefined;
    }
    clearPrefetchRetry();
    if (provider) {
      provider.saveTokens({ access_token: '', token_type: 'bearer' });
    }
  }

  function stop(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (rediscoveryTimer) {
      clearTimeout(rediscoveryTimer);
      rediscoveryTimer = undefined;
    }
    clearPrefetchRetry();
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
    getAuthProvider,
    getAuthMode,
    invalidate,
    stop,
  };
}

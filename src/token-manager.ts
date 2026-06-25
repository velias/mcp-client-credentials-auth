import {
  ClientCredentialsProvider,
} from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthProtectedResourceMetadata,
  OAuthTokens,
  AuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from './config.js';
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

export function createTokenManager(config: Config, logger: Logger): TokenManager {
  let authMode: AuthMode = { type: 'discovery-failed', message: 'Discovery not attempted yet' };
  let provider: ClientCredentialsProvider | undefined;
  let currentScopes: string | undefined;
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authServerMetadata: AuthorizationServerMetadata | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inflightRefresh: Promise<void> | undefined;

  const timeoutFetch: typeof globalThis.fetch = (input, init) => {
    const signal = config.requestTimeoutMs
      ? AbortSignal.timeout(config.requestTimeoutMs)
      : undefined;
    return fetch(input, { ...init, signal });
  };

  async function discover(): Promise<void> {
    const serverUrl = config.remoteMcpUrl;
    logger.info('Starting OAuth discovery', { serverUrl });

    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, timeoutFetch);
    } catch {
      logger.debug('RFC 9728 protected resource metadata not found, trying AS discovery on server URL');
      resourceMetadata = undefined;
    }

    const authServerUrl = resourceMetadata?.authorization_servers?.[0] ?? serverUrl;

    try {
      authServerMetadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: timeoutFetch });
    } catch {
      authServerMetadata = undefined;
    }

    if (!authServerMetadata) {
      logger.warn(
        'Remote server does not announce auth requirements -- proxying without authentication',
      );
      if (config.clientId && config.clientSecret) {
        logger.warn(
          'Credentials were provided but remote server does not announce auth requirements -- proxying without authentication. Verify the remote server\'s OAuth configuration.',
        );
      }
      authMode = { type: 'no-auth' };
      return;
    }

    const grantTypes = authServerMetadata.grant_types_supported ?? ['authorization_code'];
    if (!grantTypes.includes('client_credentials')) {
      const msg = `Remote MCP server requires authentication but its IdP does not support client_credentials grant. Supported grants: [${grantTypes.join(', ')}]. This proxy only supports client_credentials.`;
      logger.error(msg);
      authMode = { type: 'unsupported-grant', message: msg };
      return;
    }

    if (resourceMetadata?.scopes_supported?.length) {
      currentScopes = resourceMetadata.scopes_supported.join(' ');
    }

    provider = new ClientCredentialsProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(currentScopes ? { scope: currentScopes } : {}),
    });

    installRefreshHook(provider);

    authMode = { type: 'authenticated', provider };
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

  function getRetryIntervalMs(): number {
    const skewMs = config.refreshSkewSeconds * 1000;
    // Distribute retries evenly within the skew window
    return Math.max(Math.min(5_000, Math.floor(skewMs / (MAX_REFRESH_RETRIES + 1))), 500);
  }

  async function performRefresh(): Promise<void> {
    if (!provider) return;
    logger.debug('Starting proactive token refresh');
    try {
      const result = await auth(provider, { serverUrl: config.remoteMcpUrl, fetchFn: timeoutFetch });
      if (result === 'AUTHORIZED') {
        logger.info('Proactive token refresh successful');
        refreshRetryCount = 0;
      }
    } catch (err) {
      refreshRetryCount++;
      if (refreshRetryCount < MAX_REFRESH_RETRIES) {
        const retryMs = getRetryIntervalMs();
        logger.warn('Proactive token refresh failed, scheduling retry', {
          error: err instanceof Error ? err.message : String(err),
          attempt: refreshRetryCount,
          maxAttempts: MAX_REFRESH_RETRIES,
          retryInMs: retryMs,
        });
        refreshTimer = setTimeout(() => void doProactiveRefresh(), retryMs);
      } else {
        logger.warn('Proactive token refresh failed after max retries (will retry on next 401)', {
          error: err instanceof Error ? err.message : String(err),
          attempts: refreshRetryCount,
        });
        refreshRetryCount = 0;
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
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Token prefetch failed (will retry on first request)', {
        error: message,
      });
    }
  }

  function invalidate(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (provider) {
      provider.saveTokens({ access_token: '', token_type: 'bearer' });
    }
  }

  function stop(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
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

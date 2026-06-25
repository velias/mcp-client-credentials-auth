import {
  ClientCredentialsProvider,
} from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthProtectedResourceMetadata,
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
}

export function createTokenManager(config: Config, logger: Logger): TokenManager {
  let authMode: AuthMode = { type: 'discovery-failed', message: 'Discovery not attempted yet' };
  let provider: ClientCredentialsProvider | undefined;
  let cachedToken: string | undefined;
  let inflight: Promise<string> | undefined;
  let currentScopes: string | undefined;
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authServerMetadata: AuthorizationServerMetadata | undefined;

  async function discover(): Promise<void> {
    const serverUrl = config.remoteMcpUrl;

    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    } catch {
      logger.debug('RFC 9728 protected resource metadata not found, trying AS discovery on server URL');
      resourceMetadata = undefined;
    }

    const authServerUrl = resourceMetadata?.authorization_servers?.[0] ?? serverUrl;

    try {
      authServerMetadata = await discoverAuthorizationServerMetadata(authServerUrl);
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

    authMode = { type: 'authenticated', provider };
    logger.info('OAuth discovery complete', {
      tokenEndpoint: authServerMetadata.token_endpoint,
      scopes: currentScopes ?? '(default)',
    });
  }

  async function acquireToken(): Promise<string> {
    if (authMode.type === 'no-auth') {
      return '';
    }
    if (authMode.type === 'unsupported-grant') {
      throw new Error(authMode.message);
    }
    if (authMode.type === 'discovery-failed') {
      await discover();
      return acquireToken();
    }

    if (!provider) {
      throw new Error('TokenManager: provider not initialized');
    }

    const existingTokens = provider.tokens();
    if (existingTokens?.access_token) {
      cachedToken = existingTokens.access_token;
      return cachedToken;
    }

    throw new Error('Token acquisition failed: no token available after auth flow');
  }

  async function refreshToken(): Promise<string> {
    if (!inflight) {
      inflight = doRefresh().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  async function doRefresh(): Promise<string> {
    try {
      const token = await acquireToken();
      return token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Token acquisition failed', { error: message });
      throw err;
    }
  }

  async function prefetch(): Promise<void> {
    if (authMode.type !== 'authenticated') {
      return;
    }
    try {
      await refreshToken();
      logger.info('Token prefetch successful');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Token prefetch failed (will retry on first request)', {
        error: message,
      });
    }
  }

  function invalidate(): void {
    cachedToken = undefined;
    if (provider) {
      provider.saveTokens({ access_token: '', token_type: 'bearer' });
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
  };
}

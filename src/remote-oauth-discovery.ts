import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import type {
  OAuthProtectedResourceMetadata,
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

export interface OAuthDiscoverySnapshot {
  authModeType: AuthMode['type'];
  authorizationServerUrl?: string;
  tokenEndpoint?: string;
  issuer?: string;
  /** Joined scopes_supported from PRM when MCP_CC_PROXY_SCOPES is unset. */
  discoveredScopes?: string;
}

export interface OAuthDiscoveryResult {
  authMode: AuthMode;
  provider?: ClientCredentialsProvider;
  currentScopes?: string;
  resourceMetadata?: OAuthProtectedResourceMetadata;
  authServerMetadata?: AuthorizationServerMetadata;
  snapshot: OAuthDiscoverySnapshot;
}

/**
 * Attach optional OAuthClientProvider discovery hooks so auth() can reuse cached PRM/AS state.
 * When omitResourceParam is set, validateResourceURL returns undefined (manual token endpoint).
 */
function attachDiscoveryStateHooks(
  provider: ClientCredentialsProvider,
  initialState: OAuthDiscoveryState,
  options?: { omitResourceParam?: boolean },
): void {
  let discoveryState = initialState;
  const extensible = provider as ClientCredentialsProvider & OAuthClientProvider;
  extensible.discoveryState = () => discoveryState;
  extensible.saveDiscoveryState = (state: OAuthDiscoveryState) => {
    discoveryState = state;
  };
  if (options?.omitResourceParam) {
    extensible.validateResourceURL = () => Promise.resolve(undefined);
  }
}

export function seedManualDiscoveryState(
  provider: ClientCredentialsProvider,
  tokenEndpoint: string,
  remoteMcpUrl: string,
): void {
  const issuer = new URL(tokenEndpoint).origin;
  // ClientCredentialsProvider does not declare these optional OAuthClientProvider hooks;
  // assign them so auth() skips RFC 9728 / AS rediscovery and omits the resource param.
  attachDiscoveryStateHooks(
    provider,
    {
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
    },
    { omitResourceParam: true },
  );
}

export function seedDiscoveredAuthState(
  provider: ClientCredentialsProvider,
  authorizationServerUrl: string,
  authServerMetadata: AuthorizationServerMetadata,
  resourceMetadata: OAuthProtectedResourceMetadata | undefined,
): void {
  attachDiscoveryStateHooks(provider, {
    authorizationServerUrl,
    authorizationServerMetadata: authServerMetadata,
    resourceMetadata,
  });
}

function buildSnapshot(
  authMode: AuthMode,
  authorizationServerUrl: string | undefined,
  authServerMetadata: AuthorizationServerMetadata | undefined,
  resourceMetadata: OAuthProtectedResourceMetadata | undefined,
  configScopes: string | undefined,
): OAuthDiscoverySnapshot {
  return {
    authModeType: authMode.type,
    authorizationServerUrl,
    tokenEndpoint: authServerMetadata?.token_endpoint,
    issuer: authServerMetadata?.issuer,
    discoveredScopes: configScopes
      ? undefined
      : resourceMetadata?.scopes_supported?.length
        ? resourceMetadata.scopes_supported.join(' ')
        : undefined,
  };
}

export function describeSignificantOAuthChanges(
  previous: OAuthDiscoverySnapshot,
  next: OAuthDiscoverySnapshot,
): string[] {
  const changes: string[] = [];
  if (previous.authModeType !== next.authModeType) {
    changes.push(`authMode ${previous.authModeType} -> ${next.authModeType}`);
  }
  if (previous.authorizationServerUrl !== next.authorizationServerUrl) {
    changes.push('authorizationServerUrl');
  }
  if (previous.tokenEndpoint !== next.tokenEndpoint) {
    changes.push('tokenEndpoint');
  }
  if (previous.issuer !== next.issuer) {
    changes.push('issuer');
  }
  if (previous.discoveredScopes !== next.discoveredScopes) {
    changes.push('discoveredScopes');
  }
  return changes;
}

export function isSignificantOAuthChange(
  previous: OAuthDiscoverySnapshot,
  next: OAuthDiscoverySnapshot,
): boolean {
  return describeSignificantOAuthChanges(previous, next).length > 0;
}

/**
 * Discover OAuth PRM/AS metadata for the remote MCP URL (or configure manual token endpoint).
 */
export async function discoverOAuthForRemote(
  config: Config,
  logger: Logger,
  timeoutFetch: typeof globalThis.fetch,
  createAuthenticatedProvider: (scopes: string | undefined) => ClientCredentialsProvider,
): Promise<OAuthDiscoveryResult> {
  if (config.tokenEndpoint) {
    let currentScopes: string | undefined;
    if (config.scopes) {
      currentScopes = config.scopes;
      logger.info('Using scopes from MCP_CC_PROXY_SCOPES', {
        scopes: currentScopes,
      });
    }

    const provider = createAuthenticatedProvider(currentScopes);
    seedManualDiscoveryState(provider, config.tokenEndpoint, config.remoteMcpUrl);

    const authMode: AuthMode = { type: 'authenticated', provider };
    const issuer = new URL(config.tokenEndpoint).origin;
    logger.info('Using manual token endpoint (skipping OAuth discovery)', {
      tokenEndpoint: config.tokenEndpoint,
      scopes: currentScopes ?? '(none)',
    });

    return {
      authMode,
      provider,
      currentScopes,
      snapshot: buildSnapshot(
        authMode,
        issuer,
        {
          issuer,
          token_endpoint: config.tokenEndpoint,
        } as AuthorizationServerMetadata,
        undefined,
        config.scopes,
      ),
    };
  }

  const serverUrl = config.remoteMcpUrl;
  logger.info('Starting OAuth discovery', { serverUrl });

  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
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

  let authServerMetadata: AuthorizationServerMetadata | undefined;
  let asDiscoveryFailed = false;
  try {
    authServerMetadata = await discoverAuthorizationServerMetadata(authServerUrl, {
      fetchFn: timeoutFetch,
    });
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
        'OAuth discovery failed (both resource and authorization server endpoints unreachable)';
      const msg = formatProxyError('authentication', detail);
      logger.warn(msg, { category: 'authentication' });
      const authMode: AuthMode = { type: 'discovery-failed', message: msg };
      return {
        authMode,
        snapshot: buildSnapshot(authMode, undefined, undefined, undefined, config.scopes),
      };
    }

    logger.warn(
      'Remote server does not announce auth requirements -- proxying without authentication',
    );
    const authMode: AuthMode = { type: 'no-auth' };
    return {
      authMode,
      resourceMetadata,
      snapshot: buildSnapshot(authMode, authServerUrl, undefined, resourceMetadata, config.scopes),
    };
  }

  const grantTypes = authServerMetadata.grant_types_supported ?? ['authorization_code'];
  if (!grantTypes.includes('client_credentials')) {
    const detail =
      `Remote MCP server requires authentication but its IdP does not support client_credentials grant. ` +
      `Supported grants: [${grantTypes.join(', ')}]. This proxy only supports client_credentials.`;
    const msg = formatProxyError('authentication', detail);
    logger.error(msg, { category: 'authentication' });
    const authMode: AuthMode = { type: 'unsupported-grant', message: msg };
    return {
      authMode,
      resourceMetadata,
      authServerMetadata,
      snapshot: buildSnapshot(
        authMode,
        authServerUrl,
        authServerMetadata,
        resourceMetadata,
        config.scopes,
      ),
    };
  }

  let currentScopes: string | undefined;
  if (config.scopes) {
    currentScopes = config.scopes;
    logger.info('Using scopes from MCP_CC_PROXY_SCOPES (overriding discovery)', {
      scopes: currentScopes,
    });
  } else if (resourceMetadata?.scopes_supported?.length) {
    currentScopes = resourceMetadata.scopes_supported.join(' ');
  }

  const provider = createAuthenticatedProvider(currentScopes);
  seedDiscoveredAuthState(provider, authServerUrl, authServerMetadata, resourceMetadata);

  const authMode: AuthMode = { type: 'authenticated', provider };
  logger.info('OAuth discovery complete', {
    tokenEndpoint: authServerMetadata.token_endpoint,
    scopes: currentScopes ?? '(default)',
  });

  return {
    authMode,
    provider,
    currentScopes,
    resourceMetadata,
    authServerMetadata,
    snapshot: buildSnapshot(
      authMode,
      authServerUrl,
      authServerMetadata,
      resourceMetadata,
      config.scopes,
    ),
  };
}

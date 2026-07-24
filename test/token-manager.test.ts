import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createTokenManager } from '../src/token-manager.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';

/** Partial AS metadata for tests; SDK type requires many OIDC fields we do not exercise. */
function asMetadata(
  partial: Pick<AuthorizationServerMetadata, 'issuer' | 'token_endpoint'> &
    Partial<AuthorizationServerMetadata>,
): AuthorizationServerMetadata {
  return partial as AuthorizationServerMetadata;
}

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>();
  return {
    ...actual,
    auth: vi.fn().mockResolvedValue('AUTHORIZED'),
    discoverOAuthProtectedResourceMetadata: vi.fn(),
    discoverAuthorizationServerMetadata: vi.fn(),
  };
});

import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';

const mockAuth = vi.mocked(auth);
const mockDiscoverResource = vi.mocked(discoverOAuthProtectedResourceMetadata);
const mockDiscoverAS = vi.mocked(discoverAuthorizationServerMetadata);

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isDebugEnabled: false,
  };
}

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    remoteMcpUrl: 'https://mcp.example.com/mcp',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    refreshSkewSeconds: 30,
    requestTimeoutMs: 30000,
    startupTimeoutMs: 60000,
    capabilitiesPollSeconds: 60,
    transport: 'stdio',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    listenPath: '/mcp',
    oauthRediscoverySeconds: 3600,
    httpSessionIdleSeconds: 1800,
    debug: false,
    ...overrides,
  };
}

function setupAuthenticatedDiscovery(): void {
  mockDiscoverResource.mockResolvedValue({
    resource: 'https://mcp.example.com/mcp',
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['read', 'write'],
  });
  mockDiscoverAS.mockResolvedValue(
    asMetadata({
      issuer: 'https://auth.example.com',
      token_endpoint: 'https://auth.example.com/token',
      grant_types_supported: ['client_credentials', 'authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    }),
  );
}

describe('TokenManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('discover', () => {
    it('enters no-auth mode when no well-known metadata found', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(tm.getAuthMode().type).toBe('no-auth');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('does not announce auth requirements'),
      );
    });

    it('enters authenticated mode when discovery succeeds with client_credentials', async () => {
      setupAuthenticatedDiscovery();

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(tm.getAuthProvider()).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        'OAuth discovery complete',
        expect.objectContaining({
          tokenEndpoint: 'https://auth.example.com/token',
        }),
      );
    });

    it('enters unsupported-grant mode when client_credentials not in grant_types_supported', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAS.mockResolvedValue(
        asMetadata({
          issuer: 'https://auth.example.com',
          token_endpoint: 'https://auth.example.com/token',
          grant_types_supported: ['authorization_code'],
        }),
      );

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const mode = tm.getAuthMode();
      expect(mode.type).toBe('unsupported-grant');
      if (mode.type === 'unsupported-grant') {
        expect(mode.message).toContain('mcp-client-credentials-auth [authentication]:');
        expect(mode.message).toContain('does not support client_credentials');
      }
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('does not support client_credentials'),
        expect.objectContaining({ category: 'authentication' }),
      );
    });

    it('enters no-auth when resource discovery fails but AS returns no metadata', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(tm.getAuthMode().type).toBe('no-auth');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('does not announce auth requirements'),
      );

      tm.stop();
    });

    it('stays in discovery-failed mode when both endpoints throw', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('ECONNREFUSED'));
      mockDiscoverAS.mockRejectedValue(new Error('ECONNREFUSED'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const mode = tm.getAuthMode();
      expect(mode.type).toBe('discovery-failed');
      if (mode.type === 'discovery-failed') {
        expect(mode.message).toContain('mcp-client-credentials-auth [authentication]:');
        expect(mode.message).toContain('OAuth discovery failed');
      }
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OAuth discovery failed'),
        expect.objectContaining({ category: 'authentication' }),
      );

      tm.stop();
    });

  });

  describe('waitUntilAuthReady', () => {
    it('returns immediately for no-auth mode', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.waitUntilAuthReady(Date.now() + 60_000);

      expect(tm.getAuthMode().type).toBe('no-auth');
      expect(logger.info).toHaveBeenCalledWith(
        'Auth readiness: no-auth mode (token not required)',
      );
      tm.stop();
    });

    it('fails immediately on unsupported-grant', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAS.mockResolvedValue(
        asMetadata({
          issuer: 'https://auth.example.com',
          token_endpoint: 'https://auth.example.com/token',
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }),
      );

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await expect(tm.waitUntilAuthReady(Date.now() + 60_000)).rejects.toThrow(
        /does not support client_credentials/,
      );
      tm.stop();
    });

    it('retries discovery-failed until success within the deadline', async () => {
      mockDiscoverResource.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockDiscoverAS.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      const ready = tm.waitUntilAuthReady(Date.now() + 60_000);

      await vi.advanceTimersByTimeAsync(0);
      expect(tm.getAuthMode().type).toBe('discovery-failed');

      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await ready;

      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(tm.hasUsableAccessToken()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Auth readiness: usable access token acquired',
      );
      tm.stop();
    });

    it('throws when no usable token within the deadline', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockRejectedValue(new Error('IdP unavailable'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      const ready = tm.waitUntilAuthReady(Date.now() + 100);
      const assertion = expect(ready).rejects.toThrow(/No usable access token within startup timeout/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      tm.stop();
    });

    it('fails immediately on permanent OAuth config errors without retrying', async () => {
      setupAuthenticatedDiscovery();
      class FakeInvalidScopeError extends Error {
        readonly errorCode = 'invalid_scope';
        constructor(message: string) {
          super(message);
          this.name = 'InvalidScopeError';
        }
      }
      mockAuth.mockRejectedValue(new FakeInvalidScopeError('Invalid scopes: api.graphql'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await expect(tm.waitUntilAuthReady(Date.now() + 60_000)).rejects.toThrow(
        /Unrecoverable OAuth misconfiguration at the identity provider \(IdP\): Invalid scopes: api\.graphql/,
      );
      expect(mockAuth).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /at the identity provider \(IdP\): Invalid scopes: api\.graphql.*IdP rejected the token request/,
        ),
        expect.objectContaining({
          category: 'authentication',
          unrecoverable: true,
          failureSource: 'idp',
          error: 'Invalid scopes: api.graphql',
        }),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        'Auth not ready, retrying before startup deadline',
        expect.anything(),
      );
      tm.stop();
    });
  });

  describe('hasUsableAccessToken', () => {
    it('is true after successful prefetch that stores a token', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      expect(tm.hasUsableAccessToken()).toBe(false);
      await tm.prefetch();
      expect(tm.hasUsableAccessToken()).toBe(true);
      tm.stop();
    });

    it('is false after invalidate', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      tm.invalidate();
      expect(tm.hasUsableAccessToken()).toBe(false);
      tm.stop();
    });
  });

  describe('manual token endpoint', () => {
    it('enters authenticated mode without calling discovery', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig({
        tokenEndpoint: 'https://auth.example.com/oauth/token',
      });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(tm.getAuthProvider()).toBeDefined();
      expect(mockDiscoverResource).not.toHaveBeenCalled();
      expect(mockDiscoverAS).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Using manual token endpoint (skipping OAuth discovery)',
        expect.objectContaining({
          tokenEndpoint: 'https://auth.example.com/oauth/token',
          scopes: '(none)',
        }),
      );
    });

    it('seeds discoveryState with the configured token_endpoint', async () => {
      const logger = createMockLogger();
      const config = createTestConfig({
        tokenEndpoint: 'https://auth.example.com/oauth/token',
      });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as {
        discoveryState?: () => { authorizationServerMetadata?: { token_endpoint?: string } };
      };
      const state = provider.discoveryState?.();
      expect(state?.authorizationServerMetadata?.token_endpoint).toBe(
        'https://auth.example.com/oauth/token',
      );
    });

    it('applies scopes from config.scopes', async () => {
      const logger = createMockLogger();
      const config = createTestConfig({
        tokenEndpoint: 'https://auth.example.com/oauth/token',
        scopes: 'inventory.read orders.write',
      });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('inventory.read orders.write');
      expect(logger.info).toHaveBeenCalledWith(
        'Using scopes from MCP_CC_PROXY_SCOPES',
        expect.objectContaining({ scopes: 'inventory.read orders.write' }),
      );
    });

    it('omits scope when config.scopes is not set', async () => {
      const logger = createMockLogger();
      const config = createTestConfig({
        tokenEndpoint: 'https://auth.example.com/oauth/token',
      });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBeUndefined();
    });

    it('acquires a token via waitUntilAuthReady when IdP recovers', async () => {
      mockAuth
        .mockRejectedValueOnce(new Error('IdP unavailable'))
        .mockImplementation(async (provider) => {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
          return 'AUTHORIZED';
        });

      const logger = createMockLogger();
      const config = createTestConfig({
        tokenEndpoint: 'https://auth.example.com/oauth/token',
      });
      const tm = createTokenManager(config, logger);

      const ready = tm.waitUntilAuthReady(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await ready;

      expect(tm.hasUsableAccessToken()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Auth readiness: usable access token acquired',
      );
      tm.stop();
    });
  });

  describe('scope resolution', () => {
    it('uses config.scopes over discovered scopes_supported', async () => {
      setupAuthenticatedDiscovery();

      const logger = createMockLogger();
      const config = createTestConfig({ scopes: 'https://my-api.example.com/.default' });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('https://my-api.example.com/.default');
      expect(logger.info).toHaveBeenCalledWith(
        'Using scopes from MCP_CC_PROXY_SCOPES (overriding discovery)',
        expect.objectContaining({ scopes: 'https://my-api.example.com/.default' }),
      );
    });

    it('uses config.scopes when scopes_supported is empty', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAS.mockResolvedValue(
        asMetadata({
          issuer: 'https://auth.example.com',
          token_endpoint: 'https://auth.example.com/token',
          grant_types_supported: ['client_credentials'],
        }),
      );

      const logger = createMockLogger();
      const config = createTestConfig({ scopes: 'custom:scope' });
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('custom:scope');
    });

    it('falls back to discovered scopes when config.scopes is not set', async () => {
      setupAuthenticatedDiscovery();

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('read write');
      expect(logger.info).not.toHaveBeenCalledWith(
        'Using scopes from MCP_CC_PROXY_SCOPES (overriding discovery)',
        expect.anything(),
      );
    });

    it('omits scope when neither config.scopes nor scopes_supported is set', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockDiscoverAS.mockResolvedValue(
        asMetadata({
          issuer: 'https://auth.example.com',
          token_endpoint: 'https://auth.example.com/token',
          grant_types_supported: ['client_credentials'],
        }),
      );

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBeUndefined();
    });
  });

  describe('getAuthProvider', () => {
    it('returns undefined when not in authenticated mode', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      expect(tm.getAuthProvider()).toBeUndefined();
    });

    it('returns provider when in authenticated mode', async () => {
      setupAuthenticatedDiscovery();

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      expect(tm.getAuthProvider()).toBeDefined();
    });
  });

  describe('prefetch', () => {
    it('does nothing when not in authenticated mode', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      expect(mockAuth).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith('Token prefetch successful');
    });

    it('calls auth() to acquire token at startup', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockResolvedValue('AUTHORIZED');

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      expect(mockAuth).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ serverUrl: 'https://mcp.example.com/mcp' }),
      );
      expect(logger.info).toHaveBeenCalledWith('Token prefetch successful');
    });

    it('logs warning when prefetch fails', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockRejectedValue(new Error('Network error'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      expect(logger.warn).toHaveBeenCalledWith(
        'Token prefetch failed',
        expect.objectContaining({ category: 'authentication', error: 'Network error' }),
      );
    });

    it('is a no-op when in discovery-failed mode', async () => {
      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      expect(tm.getAuthMode().type).toBe('discovery-failed');
      await tm.prefetch();
      expect(mockAuth).not.toHaveBeenCalled();
    });
  });

  describe('proactive token refresh', () => {
    it('schedules refresh timer when saveTokens is called with expires_in', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 30 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      expect(logger.debug).toHaveBeenCalledWith(
        'Proactive token refresh scheduled',
        expect.objectContaining({
          expiresInSeconds: 3600,
          refreshInSeconds: 3570,
        }),
      );

      tm.stop();
    });

    it('fires refresh at (expires_in - refreshSkewSeconds)', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        void provider.saveTokens({ access_token: `tok-${callCount}`, token_type: 'bearer', expires_in: 60 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 10 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      expect(callCount).toBe(1);

      // Advance to just before refresh time (50s)
      await vi.advanceTimersByTimeAsync(49_000);
      expect(callCount).toBe(1);

      // Advance past refresh time
      await vi.advanceTimersByTimeAsync(2_000);
      expect(callCount).toBe(2);
      expect(logger.info).toHaveBeenCalledWith('Proactive token refresh successful');

      tm.stop();
    });

    it('deduplicates concurrent refresh calls', async () => {
      setupAuthenticatedDiscovery();
      let resolveAuth: (() => void) | undefined;
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        if (callCount === 1) {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 10 });
        } else {
          await new Promise<void>((r) => { resolveAuth = r; });
          void provider.saveTokens({ access_token: 'tok2', token_type: 'bearer', expires_in: 3600 });
        }
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 5 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      // Trigger the refresh timer
      await vi.advanceTimersByTimeAsync(5_000);

      // auth is now in-flight; callCount should be 2
      expect(callCount).toBe(2);

      // Resolve the in-flight auth
      resolveAuth!();
      await vi.advanceTimersByTimeAsync(0);

      tm.stop();
    });

    it('retries on refresh failure before giving up', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        if (callCount === 1) {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 100 });
          return 'AUTHORIZED';
        }
        throw new Error('IdP unavailable');
      });

      const logger = createMockLogger();
      // 30s skew → retry interval = min(5000, 30000/4) = 5000ms
      const config = createTestConfig({ refreshSkewSeconds: 30 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      // First refresh fires at (100-30)=70s, fails → schedules retry in 5s
      await vi.advanceTimersByTimeAsync(70_000);
      expect(callCount).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh failed, scheduling retry',
        expect.objectContaining({ error: 'IdP unavailable', attempt: 1, retryInMs: 5000 }),
      );

      // Retry fires at +5s, fails again → schedules another retry
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callCount).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh failed, scheduling retry',
        expect.objectContaining({ attempt: 2 }),
      );

      // Third attempt at +5s, fails → switches to extended backoff
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callCount).toBe(4);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh exhausted fast retries, switching to extended backoff',
        expect.objectContaining({ error: 'IdP unavailable', attempts: 3 }),
      );

      tm.stop();
    });

    it('adapts retry interval to short skew periods', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        if (callCount === 1) {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 10 });
          return 'AUTHORIZED';
        }
        throw new Error('IdP unavailable');
      });

      const logger = createMockLogger();
      // 5s skew → retry interval = min(5000, 5000/4) = 1250ms
      const config = createTestConfig({ refreshSkewSeconds: 5 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      // First refresh fires at (10-5)=5s
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callCount).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh failed, scheduling retry',
        expect.objectContaining({ retryInMs: 1250 }),
      );

      // Retry fires at +1250ms
      await vi.advanceTimersByTimeAsync(1_250);
      expect(callCount).toBe(3);

      // Another retry at +1250ms → switches to extended backoff
      await vi.advanceTimersByTimeAsync(1_250);
      expect(callCount).toBe(4);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh exhausted fast retries, switching to extended backoff',
        expect.objectContaining({ attempts: 3 }),
      );

      tm.stop();
    });

    it('recovers from extended backoff when IdP comes back', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        if (callCount === 1) {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 100 });
          return 'AUTHORIZED';
        }
        if (callCount <= 4) {
          throw new Error('IdP unavailable');
        }
        void provider.saveTokens({ access_token: 'tok-recovered', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 30 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      expect(callCount).toBe(1);

      // Fast retries exhaust at 70s + 5s + 5s = 80s
      await vi.advanceTimersByTimeAsync(80_000);
      expect(callCount).toBe(4);
      expect(logger.warn).toHaveBeenCalledWith(
        'Proactive token refresh exhausted fast retries, switching to extended backoff',
        expect.anything(),
      );

      // Extended backoff retry succeeds (~30s later)
      await vi.advanceTimersByTimeAsync(40_000);
      expect(callCount).toBe(5);
      expect(logger.info).toHaveBeenCalledWith('Proactive token refresh successful');

      tm.stop();
    });

    it('does not schedule refresh when expires_in is missing', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer' });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      expect(logger.debug).not.toHaveBeenCalledWith(
        'Proactive token refresh scheduled',
        expect.anything(),
      );

      tm.stop();
    });

    it('uses minimum 1s refresh delay even when refreshSkewSeconds > expires_in', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 5 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 100 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      expect(logger.debug).toHaveBeenCalledWith(
        'Proactive token refresh scheduled',
        expect.objectContaining({ refreshInSeconds: 1 }),
      );

      tm.stop();
    });
  });

  describe('stop', () => {
    it('cancels the refresh timer', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 10 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 5 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();
      expect(callCount).toBe(1);

      tm.stop();

      // Advance past the refresh time -- should NOT trigger
      await vi.advanceTimersByTimeAsync(10_000);
      expect(callCount).toBe(1);
    });
  });

  describe('invalidate', () => {
    it('clears the token from the provider', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        void provider.saveTokens({ access_token: 'valid-token', token_type: 'bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      const provider = tm.getAuthProvider() as { tokens: () => { access_token: string } | undefined };
      expect(provider.tokens()?.access_token).toBe('valid-token');

      tm.invalidate();
      expect(provider.tokens()?.access_token).toBe('');

      tm.stop();
    });

    it('cancels refresh timer on invalidate', async () => {
      setupAuthenticatedDiscovery();
      let callCount = 0;
      mockAuth.mockImplementation(async (provider) => {
        callCount++;
        if (callCount === 1) {
          void provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 10 });
        }
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const config = createTestConfig({ refreshSkewSeconds: 5 });
      const tm = createTokenManager(config, logger);

      await tm.discover();
      await tm.prefetch();

      tm.invalidate();

      // Advance past what would have been the refresh time
      await vi.advanceTimersByTimeAsync(10_000);
      // auth should only have been called once (the prefetch)
      expect(callCount).toBe(1);
    });

    it('is safe to call when provider is not initialized', () => {
      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      expect(() => tm.invalidate()).not.toThrow();
    });
  });

  describe('stepUpScopes', () => {
    it('mutates clientMetadata.scope, calls auth, and stores a usable token', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'step-up-token',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();

      await tm.stepUpScopes('email');

      const provider = tm.getAuthProvider() as {
        clientMetadata: { scope?: string };
        tokens: () => { access_token?: string } | undefined;
      };
      expect(provider.clientMetadata.scope).toBe('read write email');
      expect(tm.getCurrentScopes()).toBe('read write email');
      expect(tm.getAccessToken()).toBe('step-up-token');
      expect(mockAuth).toHaveBeenCalled();
    });

    it('accumulates scopes across sequential step-ups (does not overwrite)', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();

      await tm.stepUpScopes('email');
      await tm.stepUpScopes('orders.write');

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('read write email orders.write');
      expect(tm.getCurrentScopes()).toBe('read write email orders.write');
    });

    it('coalesces concurrent step-ups into one in-flight acquisition covering merged scopes', async () => {
      setupAuthenticatedDiscovery();
      let authCalls = 0;
      mockAuth.mockImplementation(async (provider) => {
        authCalls++;
        await Promise.resolve();
        await Promise.resolve(provider.saveTokens({
          access_token: `tok-${authCalls}`,
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();

      await Promise.all([tm.stepUpScopes('email'), tm.stepUpScopes('orders.write')]);

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('read write email orders.write');
      // First auth may race before the second merge; a second pass covers remaining scopes.
      expect(authCalls).toBeGreaterThanOrEqual(1);
      expect(authCalls).toBeLessThanOrEqual(2);
      expect(tm.getAccessToken()).toBeTruthy();
    });

    it('returns a step-up fetch wrapper when authenticated', async () => {
      setupAuthenticatedDiscovery();
      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();
      expect(typeof tm.getScopeStepUpFetch()).toBe('function');
    });

    it('restores prior scopes and access token when step-up auth fails', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'good-token',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();
      await tm.prefetch();
      expect(tm.getAccessToken()).toBe('good-token');
      expect(tm.getCurrentScopes()).toBe('read write');

      mockAuth.mockRejectedValueOnce(
        Object.assign(new Error('Invalid scopes: evil.admin'), { errorCode: 'invalid_scope' }),
      );

      await expect(tm.stepUpScopes('evil.admin')).rejects.toThrow(/Invalid scopes: evil\.admin/);

      const provider = tm.getAuthProvider() as { clientMetadata: { scope?: string } };
      expect(provider.clientMetadata.scope).toBe('read write');
      expect(tm.getCurrentScopes()).toBe('read write');
      expect(tm.getAccessToken()).toBe('good-token');
      expect(tm.hasUsableAccessToken()).toBe(true);
    });

    it('restores baseline when a concurrent challenge poisons an in-flight step-up', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'good-token',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();
      await tm.prefetch();

      let authCalls = 0;
      mockAuth.mockImplementation(async () => {
        authCalls++;
        await Promise.resolve();
        throw Object.assign(new Error('Invalid scopes'), { errorCode: 'invalid_scope' });
      });

      const results = await Promise.allSettled([
        tm.stepUpScopes('email'),
        tm.stepUpScopes('evil.admin'),
      ]);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(authCalls).toBeGreaterThanOrEqual(1);
      expect(tm.getCurrentScopes()).toBe('read write');
      expect(tm.getAccessToken()).toBe('good-token');
      expect(tm.hasUsableAccessToken()).toBe(true);
    });
  });

  describe('rediscoverOAuthMetadata', () => {
    it('keeps the current token when metadata is unchanged', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();
      await tm.prefetch();
      expect(tm.getAccessToken()).toBe('tok');

      await tm.rediscoverOAuthMetadata();

      expect(tm.getAccessToken()).toBe('tok');
      expect(logger.info).toHaveBeenCalledWith('OAuth rediscovery unchanged');
    });

    it('clears and reacquires token on significant metadata change', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok-old',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();
      await tm.prefetch();

      mockDiscoverAS.mockResolvedValue(
        asMetadata({
          issuer: 'https://auth.example.com',
          token_endpoint: 'https://auth.example.com/token-v2',
          grant_types_supported: ['client_credentials', 'authorization_code'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }),
      );
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok-new',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      await tm.rediscoverOAuthMetadata();

      expect(logger.info).toHaveBeenCalledWith(
        'OAuth rediscovery detected significant change; reacquiring token',
        expect.objectContaining({ changes: expect.arrayContaining(['tokenEndpoint']) }),
      );
      expect(tm.getAccessToken()).toBe('tok-new');
    });

    it('skips rediscovery when manual token endpoint is configured', async () => {
      const logger = createMockLogger();
      const tm = createTokenManager(
        createTestConfig({ tokenEndpoint: 'https://auth.example.com/oauth/token' }),
        logger,
      );
      await tm.discover();

      mockDiscoverResource.mockClear();
      mockDiscoverAS.mockClear();
      await tm.rediscoverOAuthMetadata();

      expect(mockDiscoverResource).not.toHaveBeenCalled();
      expect(mockDiscoverAS).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Skipping OAuth rediscovery (manual token endpoint configured)',
      );
    });

    it('coalesces concurrent rediscovery calls', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const tm = createTokenManager(createTestConfig(), createMockLogger());
      await tm.discover();

      let discoverCalls = 0;
      mockDiscoverResource.mockImplementation(async () => {
        discoverCalls++;
        await Promise.resolve();
        return {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['read', 'write'],
        };
      });

      await Promise.all([tm.rediscoverOAuthMetadata(), tm.rediscoverOAuthMetadata()]);
      expect(discoverCalls).toBe(1);
    });

    it('debounces non-forced rediscovery within 5 minutes', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();

      let discoverCalls = 0;
      mockDiscoverResource.mockImplementation(async () => {
        discoverCalls++;
        await Promise.resolve();
        return {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['read', 'write'],
        };
      });

      await tm.rediscoverOAuthMetadata();
      expect(discoverCalls).toBe(1);

      await tm.rediscoverOAuthMetadata();
      expect(discoverCalls).toBe(1);
      expect(logger.debug).toHaveBeenCalledWith(
        'Skipping OAuth rediscovery (recent attempt)',
        expect.objectContaining({ minIntervalMs: 5 * 60 * 1000 }),
      );

      await tm.rediscoverOAuthMetadata({ force: true });
      expect(discoverCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await tm.rediscoverOAuthMetadata();
      expect(discoverCalls).toBe(3);
    });

    it('preserves prior token when rediscovery transport fails', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();
      await tm.prefetch();

      mockDiscoverResource.mockRejectedValue(new Error('PRM down'));
      mockDiscoverAS.mockRejectedValue(new Error('AS down'));

      await tm.rediscoverOAuthMetadata();

      expect(tm.getAccessToken()).toBe('tok');
      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(logger.warn).toHaveBeenCalledWith(
        'OAuth rediscovery failed; keeping previous discovery and token',
        expect.objectContaining({ category: 'authentication' }),
      );
    });

    it('does not downgrade authenticated to no-auth on partial AS discovery failure', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(createTestConfig(), logger);
      await tm.discover();
      await tm.prefetch();

      // PRM still succeeds; AS discovery fails → discoverOAuthForRemote returns no-auth.
      mockDiscoverAS.mockRejectedValue(new Error('AS down'));

      await tm.rediscoverOAuthMetadata();

      expect(tm.getAccessToken()).toBe('tok');
      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(logger.warn).toHaveBeenCalledWith(
        'OAuth rediscovery reported no-auth while previously authenticated; keeping previous discovery and token',
        expect.objectContaining({ category: 'authentication' }),
      );
    });

    it('does not start rediscovery timer when oauthRediscoverySeconds is 0', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(
        createTestConfig({ oauthRediscoverySeconds: 0 }),
        logger,
      );
      await tm.waitUntilAuthReady(Date.now() + 5000);

      expect(logger.info).not.toHaveBeenCalledWith(
        'OAuth rediscovery schedule started',
        expect.anything(),
      );
      tm.stop();
    });

    it('invokes scheduled rediscovery on the configured interval', async () => {
      setupAuthenticatedDiscovery();
      mockAuth.mockImplementation(async (provider) => {
        await Promise.resolve(provider.saveTokens({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return 'AUTHORIZED';
      });

      const logger = createMockLogger();
      const tm = createTokenManager(
        createTestConfig({ oauthRediscoverySeconds: 10 }),
        logger,
      );
      await tm.waitUntilAuthReady(Date.now() + 5000);

      expect(logger.info).toHaveBeenCalledWith(
        'OAuth rediscovery schedule started',
        { intervalSeconds: 10 },
      );

      mockDiscoverResource.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockDiscoverResource).toHaveBeenCalled();
      tm.stop();
    });
  });
});

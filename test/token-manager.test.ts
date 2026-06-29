import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTokenManager } from '../src/token-manager.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';

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
    capabilitiesPollSeconds: 60,
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
  mockDiscoverAS.mockResolvedValue({
    issuer: 'https://auth.example.com',
    token_endpoint: 'https://auth.example.com/token',
    grant_types_supported: ['client_credentials', 'authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  });
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
      mockDiscoverAS.mockResolvedValue({
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        grant_types_supported: ['authorization_code'],
      });

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      const mode = tm.getAuthMode();
      expect(mode.type).toBe('unsupported-grant');
      if (mode.type === 'unsupported-grant') {
        expect(mode.message).toContain('does not support client_credentials');
      }
      expect(logger.error).toHaveBeenCalled();
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

      expect(tm.getAuthMode().type).toBe('discovery-failed');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OAuth discovery failed'),
      );

      tm.stop();
    });

    it('schedules re-discovery when both endpoints fail', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('ECONNREFUSED'));
      mockDiscoverAS.mockRejectedValue(new Error('ECONNREFUSED'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(logger.info).toHaveBeenCalledWith(
        'Scheduling OAuth re-discovery',
        expect.objectContaining({ attempt: 1 }),
      );

      tm.stop();
    });

    it('recovers from discovery-failed when re-discovery succeeds', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('ECONNREFUSED'));
      mockDiscoverAS.mockRejectedValue(new Error('ECONNREFUSED'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();
      expect(tm.getAuthMode().type).toBe('discovery-failed');

      setupAuthenticatedDiscovery();
      mockAuth.mockResolvedValue('AUTHORIZED');

      await vi.advanceTimersByTimeAsync(10_000);

      expect(tm.getAuthMode().type).toBe('authenticated');
      expect(tm.getAuthProvider()).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        'OAuth re-discovery succeeded, attempting token prefetch',
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
      mockDiscoverAS.mockResolvedValue({
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        grant_types_supported: ['client_credentials'],
      });

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
      mockDiscoverAS.mockResolvedValue({
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
        grant_types_supported: ['client_credentials'],
      });

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
        expect.stringContaining('Token prefetch failed'),
        expect.any(Object),
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
});

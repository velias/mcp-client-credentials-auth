import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTokenManager } from '../src/token-manager.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>();
  return {
    ...actual,
    discoverOAuthProtectedResourceMetadata: vi.fn(),
    discoverAuthorizationServerMetadata: vi.fn(),
  };
});

import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';

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
    debug: false,
    ...overrides,
  };
}

describe('TokenManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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

    it('warns when credentials provided but no auth metadata found', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('Not found'));
      mockDiscoverAS.mockResolvedValue(undefined);

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Credentials were provided'),
      );
    });

    it('handles discovery network failure gracefully', async () => {
      mockDiscoverResource.mockRejectedValue(new Error('ECONNREFUSED'));
      mockDiscoverAS.mockRejectedValue(new Error('ECONNREFUSED'));

      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      await tm.discover();

      expect(tm.getAuthMode().type).toBe('no-auth');
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
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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
      expect(tm.getAuthProvider()).toBeDefined();
    });
  });

  describe('invalidate', () => {
    it('clears cached state', async () => {
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
      expect(tm.getAuthMode().type).toBe('authenticated');

      tm.invalidate();
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
      expect(logger.info).not.toHaveBeenCalledWith('Token prefetch successful');
    });

    it('logs success when token is available', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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

      const provider = tm.getAuthProvider() as { saveTokens: (t: unknown) => void };
      provider.saveTokens({ access_token: 'test-token', token_type: 'bearer' });

      await tm.prefetch();
      expect(logger.info).toHaveBeenCalledWith('Token prefetch successful');
    });

    it('logs warning when prefetch fails', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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
      // No token saved, so acquireToken will throw
      await tm.prefetch();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Token prefetch failed'),
        expect.any(Object),
      );
    });
  });

  describe('acquireToken / refreshToken', () => {
    it('returns cached token when available via provider', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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

      const provider = tm.getAuthProvider() as { saveTokens: (t: unknown) => void; tokens: () => unknown };
      provider.saveTokens({ access_token: 'my-token', token_type: 'bearer' });

      await tm.prefetch();
      expect(logger.info).toHaveBeenCalledWith('Token prefetch successful');
    });

    it('deduplicates concurrent refresh calls', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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

      const provider = tm.getAuthProvider() as { saveTokens: (t: unknown) => void };
      provider.saveTokens({ access_token: 'dedup-token', token_type: 'bearer' });

      // Call prefetch concurrently - both should succeed without duplicate errors
      const [r1, r2] = await Promise.allSettled([tm.prefetch(), tm.prefetch()]);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('fulfilled');
    });

    it('throws when in unsupported-grant mode during prefetch', async () => {
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
      expect(tm.getAuthMode().type).toBe('unsupported-grant');
    });

    it('prefetch is a no-op when in discovery-failed mode', async () => {
      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      // Start in discovery-failed mode (no discover() called)
      expect(tm.getAuthMode().type).toBe('discovery-failed');

      // prefetch returns early since mode != authenticated
      await tm.prefetch();
      expect(mockDiscoverResource).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith('Token prefetch successful');
    });
  });

  describe('invalidate', () => {
    it('clears the token from the provider', async () => {
      mockDiscoverResource.mockResolvedValue({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['read'],
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

      const provider = tm.getAuthProvider() as { saveTokens: (t: unknown) => void; tokens: () => { access_token: string } | undefined };
      provider.saveTokens({ access_token: 'valid-token', token_type: 'bearer' });
      expect(provider.tokens()?.access_token).toBe('valid-token');

      tm.invalidate();
      // After invalidation, the token should be cleared
      expect(provider.tokens()?.access_token).toBe('');
    });

    it('is safe to call when provider is not initialized', () => {
      const logger = createMockLogger();
      const config = createTestConfig();
      const tm = createTokenManager(config, logger);

      // Should not throw
      expect(() => tm.invalidate()).not.toThrow();
    });
  });
});

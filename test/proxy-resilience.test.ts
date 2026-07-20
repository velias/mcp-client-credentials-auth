import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod/v3';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { TokenManager, AuthMode } from '../src/token-manager.js';

const permissiveSchema = z.object({}).passthrough();

let localTransportPair: [InMemoryTransport, InMemoryTransport];
const upstreamServers: Server[] = [];
let transportCallCount = 0;
let sseTransportCallCount = 0;
let transportShouldFail: (callIndex: number) => boolean = () => false;
let streamableHttpThrow: ((callIndex: number) => Error | undefined) = () => undefined;

class FakeInvalidScopeError extends Error {
  readonly errorCode = 'invalid_scope';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScopeError';
  }
}

function createUpstreamServer() {
  const server = new Server(
    { name: 'mock-upstream', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.fallbackRequestHandler = async () => ({});
  server.fallbackNotificationHandler = async () => {};
  upstreamServers.push(server);
  return server;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: '0.1.0' })),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioTransport {
    constructor() {
      localTransportPair = InMemoryTransport.createLinkedPair();
      return localTransportPair[1];
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor() {
      transportCallCount++;
      const customErr = streamableHttpThrow(transportCallCount);
      if (customErr) {
        throw customErr;
      }
      if (transportShouldFail(transportCallCount)) {
        throw new Error(`Simulated transport failure (call ${transportCallCount})`);
      }
      const pair = InMemoryTransport.createLinkedPair();
      const upstream = createUpstreamServer();
      void upstream.connect(pair[1]);
      return pair[0];
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    constructor() {
      transportCallCount++;
      sseTransportCallCount++;
      if (transportShouldFail(transportCallCount)) {
        throw new Error(`Simulated SSE transport failure (call ${transportCallCount})`);
      }
      const pair = InMemoryTransport.createLinkedPair();
      const upstream = createUpstreamServer();
      void upstream.connect(pair[1]);
      return pair[0];
    }
  },
}));

function createMockConfig(overrides?: Partial<Config>): Config {
  return {
    remoteMcpUrl: 'https://mcp.example.com/mcp',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    refreshSkewSeconds: 30,
    requestTimeoutMs: 30000,
    startupTimeoutMs: 60000,
    capabilitiesPollSeconds: 0,
    debug: false,
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isDebugEnabled: false,
  };
}

function createMockTokenManager(mode: AuthMode = { type: 'authenticated', provider: {} as never }): TokenManager {
  return {
    discover: vi.fn(),
    prefetch: vi.fn(),
    waitUntilAuthReady: vi.fn().mockResolvedValue(undefined),
    hasUsableAccessToken: vi.fn().mockReturnValue(mode.type === 'authenticated'),
    getAuthProvider: vi.fn().mockReturnValue(mode.type === 'authenticated' ? {} : undefined),
    getAuthMode: vi.fn().mockReturnValue(mode),
    invalidate: vi.fn(),
    stop: vi.fn(),
  };
}

describe('Proxy resilience', () => {
  let endClient: Client | undefined;
  let proxyHandle: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    transportShouldFail = () => false;
    streamableHttpThrow = () => undefined;
    sseTransportCallCount = 0;
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  describe('SSE fallback gating', () => {
    it('does not fall back to SSE when Streamable HTTP fails with an authentication error', async () => {
      transportCallCount = 0;
      sseTransportCallCount = 0;
      upstreamServers.length = 0;

      // Every Streamable HTTP attempt fails with invalid_scope; SSE must never be tried.
      streamableHttpThrow = () => new FakeInvalidScopeError('Invalid scopes: api.graphql');

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      await expect(
        createProxy(config, tokenManager, logger, Date.now() + 60_000),
      ).rejects.toThrow(
        /Unrecoverable OAuth misconfiguration at the identity provider \(IdP\): Invalid scopes: api\.graphql/,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'Streamable HTTP connection failed, not trying SSE fallback',
        expect.objectContaining({
          category: 'authentication',
          error: 'Invalid scopes: api.graphql',
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('at the identity provider (IdP)'),
        expect.objectContaining({ unrecoverable: true, failureSource: 'idp' }),
      );
      expect(sseTransportCallCount).toBe(0);
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Remote MCP server unreachable during discovery, retrying',
        expect.anything(),
      );
    });
  });

  describe('Phase 1 discovery failure', () => {
    it('fails immediately when the remote MCP server rejects the access token', async () => {
      const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
      transportCallCount = 0;
      sseTransportCallCount = 0;
      upstreamServers.length = 0;

      streamableHttpThrow = () => new UnauthorizedError('Unauthorized');

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      await expect(
        createProxy(config, tokenManager, logger, Date.now() + 60_000),
      ).rejects.toThrow(
        /Unrecoverable OAuth misconfiguration at the remote MCP server: Unauthorized/,
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('at the remote MCP server'),
        expect.objectContaining({
          category: 'authentication',
          unrecoverable: true,
          failureSource: 'mcp-server',
          error: 'Unauthorized',
        }),
      );
      expect(sseTransportCallCount).toBe(0);
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Remote MCP server unreachable during discovery, retrying',
        expect.anything(),
      );
    });

    it('fails startup when remote stays unreachable within the deadline', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      transportShouldFail = () => true;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      await expect(
        createProxy(config, tokenManager, logger, Date.now() + 80),
      ).rejects.toThrow(/Remote MCP server unreachable within startup timeout/);

      expect(logger.warn).toHaveBeenCalledWith(
        'Remote MCP server unreachable during discovery, retrying',
        expect.any(Object),
      );
    });

    it('retries Phase 1 and starts when remote becomes reachable before the deadline', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      // Fail first Phase 1 attempt (HTTP + SSE), succeed on retry
      transportShouldFail = (i) => i <= 2;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      proxyHandle = await createProxy(config, tokenManager, logger, Date.now() + 5000);

      expect(logger.warn).toHaveBeenCalledWith(
        'Remote MCP server unreachable during discovery, retrying',
        expect.any(Object),
      );

      endClient = new Client(
        { name: 'test-client', version: '2.5.0' },
        { capabilities: { sampling: {} } },
      );
      await endClient.connect(localTransportPair[0]);
      await new Promise((r) => setTimeout(r, 100));

      const caps = endClient.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeDefined();

      const upstream = upstreamServers[upstreamServers.length - 1];
      upstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') {
          return {
            tools: [{ name: 'recovered-tool', description: 'Works', inputSchema: { type: 'object' as const } }],
          };
        }
        return {};
      };

      const result = await endClient.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('recovered-tool');
    });
  });

  describe('Phase 3 connection failure', () => {
    it('retries and recovers when Phase 3 fails initially', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      // Phase 1 HTTP succeeds (call 1), Phase 3 fails (calls 2-3: HTTP+SSE), reconnect succeeds (call 4+)
      transportShouldFail = (i) => i === 2 || i === 3;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      proxyHandle = await createProxy(config, tokenManager, logger);

      endClient = new Client(
        { name: 'test-client', version: '2.5.0' },
        { capabilities: { sampling: {} } },
      );
      await endClient.connect(localTransportPair[0]);

      // Wait for Phase 3 failure + reconnection (attempt 0 has no backoff delay)
      await new Promise((r) => setTimeout(r, 100));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to establish real remote connection, scheduling reconnection'),
        expect.any(Object),
      );

      const upstream = upstreamServers[upstreamServers.length - 1];
      upstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') {
          return {
            tools: [{ name: 'phase3-recovered', description: 'Works', inputSchema: { type: 'object' as const } }],
          };
        }
        return {};
      };

      const result = await endClient.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('phase3-recovered');
    });

    it('returns transient error while reconnecting', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      // Phase 1 HTTP succeeds (call 1), fail all subsequent connections (Phase 3 + reconnects)
      transportShouldFail = (i) => i >= 2;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      proxyHandle = await createProxy(config, tokenManager, logger);

      endClient = new Client(
        { name: 'test-client', version: '2.5.0' },
        { capabilities: { sampling: {} } },
      );
      await endClient.connect(localTransportPair[0]);

      await new Promise((r) => setTimeout(r, 100));

      await expect(
        endClient.request(
          { method: 'tools/list', params: {} } as Parameters<typeof endClient.request>[0],
          permissiveSchema,
        ),
      ).rejects.toThrow(/mcp-client-credentials-auth \[connection\].*temporarily unavailable/);
    });
  });

  describe('dynamic authProvider', () => {
    it('calls getAuthProvider on each connection attempt', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      proxyHandle = await createProxy(config, tokenManager, logger);

      endClient = new Client(
        { name: 'test-client', version: '2.5.0' },
        { capabilities: {} },
      );
      await endClient.connect(localTransportPair[0]);
      await new Promise((r) => setTimeout(r, 50));

      // Phase 1 discovery + Phase 3 real connection = at least 2 calls
      expect(tokenManager.getAuthProvider).toHaveBeenCalledTimes(2);
    });
  });
});

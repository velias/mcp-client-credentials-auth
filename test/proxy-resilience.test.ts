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
let transportShouldFail: (callIndex: number) => boolean = () => false;

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
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  describe('Phase 1 discovery failure', () => {
    it('starts with default capabilities when remote is unreachable', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      // Fail calls 1-2 (Phase 1: HTTP + SSE discovery), succeed after
      transportShouldFail = (i) => i <= 2;

      const config = createMockConfig();
      const logger = createMockLogger();
      const tokenManager = createMockTokenManager();

      const { createProxy } = await import('../src/proxy.js');
      proxyHandle = await createProxy(config, tokenManager, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Remote MCP server unreachable during discovery'),
        expect.any(Object),
      );

      endClient = new Client(
        { name: 'test-client', version: '2.5.0' },
        { capabilities: { sampling: {} } },
      );
      await endClient.connect(localTransportPair[0]);

      // Wait for Phase 3 connection (calls 3-4 succeed)
      await new Promise((r) => setTimeout(r, 300));

      const caps = endClient.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeDefined();
    });

    it('uses proxy identity when discovery fails', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      transportShouldFail = (i) => i <= 2;

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

      const serverInfo = endClient.getServerVersion();
      expect(serverInfo?.name).toBe('mcp-client-credentials-auth');
      expect(serverInfo?.version).toBe('0.1.0');
    });

    it('forwards requests after remote becomes available', async () => {
      transportCallCount = 0;
      upstreamServers.length = 0;

      transportShouldFail = (i) => i <= 2;

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
      await new Promise((r) => setTimeout(r, 300));

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

      // Wait for Phase 3 failure + reconnection
      await new Promise((r) => setTimeout(r, 2000));

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

      await new Promise((r) => setTimeout(r, 300));

      await expect(
        endClient.request(
          { method: 'tools/list', params: {} } as Parameters<typeof endClient.request>[0],
          permissiveSchema,
        ),
      ).rejects.toThrow(/temporarily unavailable/);
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
      await new Promise((r) => setTimeout(r, 200));

      // Phase 1 discovery + Phase 3 real connection = at least 2 calls
      expect(tokenManager.getAuthProvider).toHaveBeenCalledTimes(2);
    });
  });
});

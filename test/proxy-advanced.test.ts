import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v3';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { TokenManager, AuthMode } from '../src/token-manager.js';

const permissiveSchema = z.object({}).passthrough();

let localTransportPair: [InMemoryTransport, InMemoryTransport];
const upstreamServers: Server[] = [];

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

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isDebugEnabled: false,
  };
}

function createMockTokenManager(
  mode: AuthMode = { type: 'authenticated', provider: {} as never },
  opts?: { hasUsableAccessToken?: boolean },
): TokenManager {
  const hasToken = opts?.hasUsableAccessToken ?? mode.type === 'authenticated';
  return {
    discover: vi.fn(),
    prefetch: vi.fn(),
    waitUntilAuthReady: vi.fn().mockResolvedValue(undefined),
    hasUsableAccessToken: vi.fn().mockReturnValue(hasToken),
    getAuthProvider: vi.fn().mockReturnValue(mode.type === 'authenticated' ? {} : undefined),
    getAuthMode: vi.fn().mockReturnValue(mode),
    getAccessToken: vi.fn().mockReturnValue(undefined),
    getCurrentScopes: vi.fn().mockReturnValue(undefined),
    stepUpScopes: vi.fn().mockResolvedValue(undefined),
    getScopeStepUpFetch: vi.fn().mockReturnValue(fetch),
    rediscoverOAuthMetadata: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
    stop: vi.fn(),
  };
}

async function setupProxy(opts?: {
  config?: Partial<Config>;
  authMode?: AuthMode;
  hasUsableAccessToken?: boolean;
}) {

  upstreamServers.length = 0;

  const config = createMockConfig(opts?.config);
  const logger = createMockLogger();
  const tokenManager = createMockTokenManager(opts?.authMode, {
    hasUsableAccessToken: opts?.hasUsableAccessToken,
  });

  const { createStdioProxy } = await import('../src/proxy-stdio.js');
  const proxyHandle = await createStdioProxy(config, tokenManager, logger);

  const endClient = new Client(
    { name: 'test-client', version: '2.5.0' },
    { capabilities: { sampling: {}, roots: { listChanged: true } } },
  );
  await endClient.connect(localTransportPair[0]);

  // Wait for Phase 3 to complete
  await new Promise((r) => setTimeout(r, 50));

  return { proxyHandle, endClient, logger, tokenManager };
}

describe('Proxy auth mode errors', () => {
  let endClient: Client | undefined;
  let proxyHandle: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  it('rejects requests when authenticated mode has no usable access token', async () => {
    const result = await setupProxy({
      authMode: { type: 'authenticated', provider: {} as never },
      hasUsableAccessToken: false,
    });
    endClient = result.endClient;
    proxyHandle = result.proxyHandle;

    await expect(
      endClient.request(
        { method: 'tools/list', params: {} } as Parameters<typeof endClient.request>[0],
        permissiveSchema,
      ),
    ).rejects.toThrow(/mcp-client-credentials-auth \[authentication\]: no usable access token/);
  });

  it('wraps remote McpError with [remote] category', async () => {
    const result = await setupProxy();
    endClient = result.endClient;
    proxyHandle = result.proxyHandle;

    const upstream = upstreamServers[upstreamServers.length - 1];
    upstream.fallbackRequestHandler = async () => {
      throw new McpError(ErrorCode.InvalidParams, 'tool args invalid');
    };

    await expect(
      endClient.request(
        { method: 'tools/call', params: { name: 'x', arguments: {} } } as Parameters<
          typeof endClient.request
        >[0],
        permissiveSchema,
      ),
    ).rejects.toThrow(/mcp-client-credentials-auth \[remote\]/);
  });
});

describe('Proxy capabilities polling', () => {
  let endClient: Client | undefined;
  let proxyHandle: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  it('polls remote for tool changes and emits list_changed', async () => {
  
    upstreamServers.length = 0;

    const config = createMockConfig({ capabilitiesPollSeconds: 0.1 });
    const logger = createMockLogger();
    const tokenManager = createMockTokenManager();

    const toolList = [
      { name: 'tool-a', description: 'A', inputSchema: { type: 'object' as const } },
    ];

    const { createStdioProxy } = await import('../src/proxy-stdio.js');
    proxyHandle = await createStdioProxy(config, tokenManager, logger);

    // Set up request handler on all upstream servers
    for (const s of upstreamServers) {
      s.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') return { tools: toolList };
        if (request.method === 'resources/list') return { resources: [] };
        if (request.method === 'prompts/list') return { prompts: [] };
        return {};
      };
    }

    // Connect end client with notification tracking
    const notifications: string[] = [];
    endClient = new Client(
      { name: 'test-client', version: '2.5.0' },
      { capabilities: { sampling: {}, roots: { listChanged: true } } },
    );
    endClient.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification.method);
    };
    await endClient.connect(localTransportPair[0]);

    // Wait for Phase 3 + first poll (allows up to 5s jitter capped by 0.1s interval)
    await new Promise((r) => setTimeout(r, 350));

    // Update handler on the real upstream (last one)
    const upstream = upstreamServers[upstreamServers.length - 1];
    upstream.fallbackRequestHandler = async (request) => {
      if (request.method === 'tools/list') {
        return { tools: [
          { name: 'tool-a', description: 'A', inputSchema: { type: 'object' as const } },
          { name: 'tool-b', description: 'B', inputSchema: { type: 'object' as const } },
        ] };
      }
      if (request.method === 'resources/list') return { resources: [] };
      if (request.method === 'prompts/list') return { prompts: [] };
      return {};
    };

    // Wait for a later poll to detect change
    await new Promise((r) => setTimeout(r, 350));

    expect(notifications).toContain('notifications/tools/list_changed');
  });

  it('does not poll when capabilitiesPollSeconds is 0', async () => {
    const result = await setupProxy({ config: { capabilitiesPollSeconds: 0 } });
    endClient = result.endClient;
    proxyHandle = result.proxyHandle;

    const upstream = upstreamServers[upstreamServers.length - 1];
    const listToolsCalled = vi.fn();
    upstream.fallbackRequestHandler = async (request) => {
      if (request.method === 'tools/list') {
        listToolsCalled();
        return { tools: [] };
      }
      return {};
    };

    await new Promise((r) => setTimeout(r, 200));
    expect(listToolsCalled).not.toHaveBeenCalled();
  });
});

describe('Proxy resources and prompts polling', () => {
  let endClient: Client | undefined;
  let proxyHandle: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  it('polls and detects resource changes', async () => {
  
    upstreamServers.length = 0;

    const config = createMockConfig({ capabilitiesPollSeconds: 0.1 });
    const logger = createMockLogger();
    const tokenManager = createMockTokenManager();

    const resourceList = [{ uri: 'file:///a', name: 'A' }];

    const { createStdioProxy } = await import('../src/proxy-stdio.js');
    proxyHandle = await createStdioProxy(config, tokenManager, logger);

    for (const s of upstreamServers) {
      s.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') return { tools: [] };
        if (request.method === 'resources/list') return { resources: resourceList };
        if (request.method === 'prompts/list') return { prompts: [] };
        return {};
      };
    }

    const notifications: string[] = [];
    endClient = new Client(
      { name: 'test-client', version: '2.5.0' },
      { capabilities: { sampling: {} } },
    );
    endClient.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification.method);
    };
    await endClient.connect(localTransportPair[0]);

    await new Promise((r) => setTimeout(r, 350));

    // Update upstream handler after first poll
    const upstream = upstreamServers[upstreamServers.length - 1];
    upstream.fallbackRequestHandler = async (request) => {
      if (request.method === 'tools/list') return { tools: [] };
      if (request.method === 'resources/list') return { resources: [{ uri: 'file:///a', name: 'A' }, { uri: 'file:///b', name: 'B' }] };
      if (request.method === 'prompts/list') return { prompts: [] };
      return {};
    };

    await new Promise((r) => setTimeout(r, 350));
    expect(notifications).toContain('notifications/resources/list_changed');
  });

  it('polls and detects prompt changes', async () => {
  
    upstreamServers.length = 0;

    const config = createMockConfig({ capabilitiesPollSeconds: 0.1 });
    const logger = createMockLogger();
    const tokenManager = createMockTokenManager();

    const { createStdioProxy } = await import('../src/proxy-stdio.js');
    proxyHandle = await createStdioProxy(config, tokenManager, logger);

    for (const s of upstreamServers) {
      s.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') return { tools: [] };
        if (request.method === 'resources/list') return { resources: [] };
        if (request.method === 'prompts/list') return { prompts: [{ name: 'p1' }] };
        return {};
      };
    }

    const notifications: string[] = [];
    endClient = new Client(
      { name: 'test-client', version: '2.5.0' },
      { capabilities: { sampling: {} } },
    );
    endClient.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification.method);
    };
    await endClient.connect(localTransportPair[0]);

    await new Promise((r) => setTimeout(r, 350));

    const upstream = upstreamServers[upstreamServers.length - 1];
    upstream.fallbackRequestHandler = async (request) => {
      if (request.method === 'tools/list') return { tools: [] };
      if (request.method === 'resources/list') return { resources: [] };
      if (request.method === 'prompts/list') return { prompts: [{ name: 'p1' }, { name: 'p2' }] };
      return {};
    };

    await new Promise((r) => setTimeout(r, 350));
    expect(notifications).toContain('notifications/prompts/list_changed');
  });
});

describe('Proxy buildClientIdentity fallback', () => {
  let endClient: Client | undefined;
  let proxyHandle: { close(): Promise<void> } | undefined;

  afterEach(async () => {
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) await s.close().catch(() => {});
    upstreamServers.length = 0;
  });

  it('uses proxy name only when client does not provide a name', async () => {
  
    upstreamServers.length = 0;

    const config = createMockConfig();
    const logger = createMockLogger();
    const tokenManager = createMockTokenManager();

    const { createStdioProxy } = await import('../src/proxy-stdio.js');
    proxyHandle = await createStdioProxy(config, tokenManager, logger);

    // Connect a client without a name
    endClient = new Client(
      { name: '', version: '' },
      { capabilities: {} },
    );
    await endClient.connect(localTransportPair[0]);

    await new Promise((r) => setTimeout(r, 50));

    const upstream = upstreamServers[upstreamServers.length - 1];
    const clientInfo = upstream.getClientVersion();
    expect(clientInfo?.name).toBe('mcp-client-credentials-auth');
    expect(clientInfo?.version).toBe('0.1.0');
  });
});


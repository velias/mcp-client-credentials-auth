import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { TokenManager, AuthMode } from '../src/token-manager.js';

const upstreamServers: Server[] = [];
let connectCount = 0;

function createUpstreamServer() {
  const server = new Server(
    { name: 'mock-upstream', version: '1.0.0' },
    { capabilities: { tools: {} } },
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

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>();
  return {
    ...actual,
    StreamableHTTPClientTransport: class MockStreamableHTTP {
      constructor(url: URL, opts?: ConstructorParameters<typeof actual.StreamableHTTPClientTransport>[1]) {
        // Local client connecting to our HTTP proxy: use real transport.
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          return new actual.StreamableHTTPClientTransport(url, opts);
        }
        const pair = InMemoryTransport.createLinkedPair();
        connectCount++;
        const upstream = createUpstreamServer();
        void upstream.connect(pair[1]);
        return pair[0];
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  return {
    SSEClientTransport: class MockSSE {
      constructor() {
        const pair = InMemoryTransport.createLinkedPair();
        connectCount++;
        const upstream = createUpstreamServer();
        void upstream.connect(pair[1]);
        return pair[0];
      }
    },
  };
});

function createMockConfig(overrides?: Partial<Config>): Config {
  return {
    remoteMcpUrl: 'https://mcp.example.com/mcp',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    refreshSkewSeconds: 30,
    requestTimeoutMs: 30000,
    startupTimeoutMs: 60000,
    capabilitiesPollSeconds: 0,
    transport: 'http',
    listenHost: '127.0.0.1',
    listenPort: 0,
    listenPath: '/mcp',
    oauthRediscoverySeconds: 0,
    httpSessionIdleSeconds: 0,
    auditCalls: true,
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
    getAccessToken: vi.fn().mockReturnValue(undefined),
    getCurrentScopes: vi.fn().mockReturnValue(undefined),
    stepUpScopes: vi.fn().mockResolvedValue(undefined),
    getScopeStepUpFetch: vi.fn().mockReturnValue(fetch),
    rediscoverOAuthMetadata: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
    stop: vi.fn(),
  };
}

describe('HTTP proxy (createHttpProxy)', () => {
  let proxyHandle: { close(): Promise<void>; listenPort?: number } | undefined;
  let logger: Logger;
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;

  beforeEach(() => {
    connectCount = 0;
    upstreamServers.length = 0;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (proxyHandle) {
      await proxyHandle.close();
      proxyHandle = undefined;
    }
    exitSpy.mockRestore();
    vi.resetModules();
  });

  it('serves /health/live and /health/ready', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const live = await fetch(`http://127.0.0.1:${proxyHandle.listenPort}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${proxyHandle.listenPort}/health/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns 503 on /health/ready while shutting down', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);
    const port = proxyHandle.listenPort;

    const closing = proxyHandle.close();
    let readyStatus: number | undefined;
    let readyBody: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
        readyStatus = ready.status;
        readyBody = await ready.json();
        if (readyStatus === 503) break;
      } catch {
        // Listener may already be closed after the drain window.
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(readyStatus).toBe(503);
    expect(readyBody).toEqual({ status: 'shutting_down' });
    await closing;
    proxyHandle = undefined;
  });

  it('creates a session on initialize and does not exit on session close', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const url = new URL(`http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`);
    const client = new Client(
      { name: 'http-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);

    // Phase 1 + Phase 3 remote connects
    expect(connectCount).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 50));

    await client.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).not.toHaveBeenCalled();

    // Health still works after session close
    const res = await fetch(`http://127.0.0.1:${proxyHandle.listenPort}/health/live`);
    expect(res.status).toBe(200);
  });

  it('evicts idle sessions; old id returns 404; new initialize works', async () => {
    const config = createMockConfig({ httpSessionIdleSeconds: 1 });
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    expect(logger.info).toHaveBeenCalledWith(
      'HTTP session idle sweep started',
      expect.objectContaining({ idleSeconds: 1 }),
    );

    const url = new URL(`http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`);
    const client = new Client(
      { name: 'http-idle-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    const sid = transport.sessionId;
    expect(sid).toBeTruthy();

    // Idle=1s → sweep every 1s; wait past deadline + a sweep.
    await new Promise((r) => setTimeout(r, 2500));

    expect(logger.info).toHaveBeenCalledWith(
      'HTTP MCP session idle timeout',
      expect.objectContaining({ sessionId: sid, idleSeconds: 1 }),
    );

    const stale = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': sid!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(stale.status).toBe(404);

    const client2 = new Client(
      { name: 'http-idle-client-2', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport2 = new StreamableHTTPClientTransport(url);
    await client2.connect(transport2);
    expect(transport2.sessionId).toBeTruthy();
    expect(transport2.sessionId).not.toBe(sid);

    await client2.close().catch(() => {});
    await client.close().catch(() => {});
  });

  it('returns 404 for an unknown mcp-session-id', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const res = await fetch(
      `http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'missing-session',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
    });
  });

  it('returns 400 when session ID is missing on a non-initialize request', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const res = await fetch(
      `http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Session ID required' },
    });
  });

  it('handles DELETE for an unknown session with 404', async () => {
    const config = createMockConfig();
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const res = await fetch(
      `http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`,
      {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'missing-session' },
      },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
    });
  });

  it('audits tools/list with local sessionId', async () => {
    const config = createMockConfig({ auditCalls: true });
    logger = createMockLogger();
    const tokenManager = createMockTokenManager();
    const { createHttpProxy } = await import('../src/proxy-http.js');
    proxyHandle = await createHttpProxy(config, tokenManager, logger);

    const url = new URL(`http://127.0.0.1:${proxyHandle.listenPort}${config.listenPath}`);
    const client = new Client(
      { name: 'http-audit-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    const sid = transport.sessionId;
    expect(sid).toBeTruthy();

    // Wait for Phase 3 remote ready before listing.
    await new Promise((r) => setTimeout(r, 50));
    const upstream = upstreamServers[upstreamServers.length - 1];
    upstream.fallbackRequestHandler = async (request) => {
      if (request.method === 'tools/list') {
        return { tools: [] };
      }
      return {};
    };

    vi.mocked(logger.info).mockClear();
    await client.listTools();

    expect(logger.info).toHaveBeenCalledWith(
      'tools/list',
      expect.objectContaining({
        sessionId: sid,
        outcome: 'ok',
        durationMs: expect.any(Number),
      }),
    );

    await client.close().catch(() => {});
  });
});

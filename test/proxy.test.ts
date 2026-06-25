import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
let connectCount = 0;

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

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: class MockStdioTransport {
      constructor() {
        localTransportPair = InMemoryTransport.createLinkedPair();
        return localTransportPair[1];
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: class MockStreamableHTTP {
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

describe('Proxy (createProxy integration)', () => {
  let endClient: Client;
  let proxyHandle: { close(): Promise<void> };

  beforeEach(async () => {
    connectCount = 0;
    upstreamServers.length = 0;

    const config = createMockConfig();
    const logger = createMockLogger();
    const tokenManager = createMockTokenManager();

    const { createProxy } = await import('../src/proxy.js');
    proxyHandle = await createProxy(config, tokenManager, logger);

    endClient = new Client(
      { name: 'test-client', version: '2.5.0' },
      {
        capabilities: {
          sampling: {},
          roots: { listChanged: true },
        },
      },
    );
    await endClient.connect(localTransportPair[0]);

    // Wait for Phase 3 (oninitialized → reconnect) to complete
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    await proxyHandle?.close().catch(() => {});
    await endClient?.close().catch(() => {});
    for (const s of upstreamServers) {
      await s.close().catch(() => {});
    }
    upstreamServers.length = 0;
  });

  function getUpstreamServer(): Server {
    return upstreamServers[upstreamServers.length - 1];
  }

  describe('Identity forwarding', () => {
    it('forwards remote server identity to local client', () => {
      const serverInfo = endClient.getServerVersion();
      expect(serverInfo).toEqual({
        name: 'mock-upstream',
        version: '1.0.0',
      });
    });

    it('sends real client name with proxy suffix to remote server', () => {
      const upstream = getUpstreamServer();
      const clientInfo = upstream.getClientVersion();
      expect(clientInfo?.name).toBe('test-client via mcp-client-credentials-auth v0.1.0');
      expect(clientInfo?.version).toBe('2.5.0');
    });

    it('uses two connections (discovery + real)', () => {
      expect(connectCount).toBe(2);
    });

    it('discovery connection uses proxy identity', () => {
      const discoveryUpstream = upstreamServers[0];
      const clientInfo = discoveryUpstream.getClientVersion();
      expect(clientInfo?.name).toBe('mcp-client-credentials-auth');
      expect(clientInfo?.version).toBe('0.1.0');
    });
  });

  describe('Capabilities forwarding', () => {
    it('forwards client capabilities to remote server', () => {
      const upstream = getUpstreamServer();
      const clientCaps = upstream.getClientCapabilities();
      expect(clientCaps?.sampling).toBeDefined();
      expect(clientCaps?.roots).toBeDefined();
      expect(clientCaps?.roots?.listChanged).toBe(true);
    });

    it('mirrors server capabilities to end client', () => {
      const caps = endClient.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeDefined();
    });
  });

  describe('Flow 1: Client->Server request forwarding', () => {
    it('forwards tools/list through the proxy', async () => {
      const upstream = getUpstreamServer();
      upstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') {
          return {
            tools: [
              { name: 'test-tool', description: 'A test tool', inputSchema: { type: 'object' as const } },
            ],
          };
        }
        return {};
      };

      const result = await endClient.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('test-tool');
    });

    it('forwards unknown methods through the proxy', async () => {
      const upstream = getUpstreamServer();
      upstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'foo/bar') {
          return { custom: 'response', method: request.method };
        }
        return {};
      };

      const result = await endClient.request(
        { method: 'foo/bar', params: { input: 'test' } } as Parameters<typeof endClient.request>[0],
        permissiveSchema,
      );
      expect(result).toEqual({ custom: 'response', method: 'foo/bar' });
    });

    it('forwards tools/call with arguments', async () => {
      const upstream = getUpstreamServer();
      upstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/call') {
          const params = request.params as Record<string, unknown>;
          return {
            content: [{ type: 'text', text: `Called ${params.name} with ${JSON.stringify(params.arguments)}` }],
          };
        }
        return {};
      };

      const result = await endClient.callTool({ name: 'my-tool', arguments: { key: 'value' } });
      expect(result.content).toBeDefined();
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain('my-tool');
    });
  });

  describe('Flow 2: Server->Client notification forwarding', () => {
    it('forwards custom notifications from upstream to end client', async () => {
      const upstream = getUpstreamServer();
      const received = vi.fn();
      endClient.fallbackNotificationHandler = async (notification) => {
        received(notification);
      };

      await upstream.notification({
        method: 'notifications/custom/test',
        params: { data: 'hello' },
      } as Parameters<typeof upstream.notification>[0]);

      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'notifications/custom/test' }),
      );
    });
  });

  describe('Flow 3: Server->Client request forwarding', () => {
    it('forwards requests from upstream to end client', async () => {
      const upstream = getUpstreamServer();
      endClient.fallbackRequestHandler = async (request) => {
        if (request.method === 'sampling/createMessage') {
          return {
            role: 'assistant',
            model: 'test-model',
            content: { type: 'text', text: 'sampled response' },
          };
        }
        return {};
      };

      const result = await upstream.request(
        {
          method: 'sampling/createMessage',
          params: {
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100,
          },
        } as Parameters<typeof upstream.request>[0],
        permissiveSchema,
      );

      expect(result).toEqual(expect.objectContaining({ role: 'assistant', model: 'test-model' }));
    });
  });

  describe('Flow 4: Client->Server notification forwarding', () => {
    it('forwards custom notifications from end client to upstream', async () => {
      const upstream = getUpstreamServer();
      const received = vi.fn();
      upstream.fallbackNotificationHandler = async (notification) => {
        received(notification);
      };

      await endClient.notification({
        method: 'notifications/custom/fromclient',
        params: { data: 'world' },
      } as Parameters<typeof endClient.notification>[0]);

      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'notifications/custom/fromclient' }),
      );
    });

    it('strips auth-like keys from notification _meta before forwarding', async () => {
      const upstream = getUpstreamServer();
      let receivedParams: Record<string, unknown> | undefined;
      upstream.fallbackNotificationHandler = async (notification) => {
        receivedParams = notification.params as Record<string, unknown>;
      };

      await endClient.notification({
        method: 'notifications/custom/withmeta',
        params: {
          _meta: {
            authorization: 'Bearer leaked',
            token: 'secret-token',
            client_secret: 'oops',
            traceparent: '00-trace-id',
            custom: 'safe',
          },
          data: 'payload',
        },
      } as Parameters<typeof endClient.notification>[0]);

      await new Promise((r) => setTimeout(r, 100));
      expect(receivedParams?._meta).not.toHaveProperty('authorization');
      expect(receivedParams?._meta).not.toHaveProperty('token');
      expect(receivedParams?._meta).not.toHaveProperty('client_secret');
      expect(receivedParams?._meta).toHaveProperty('traceparent', '00-trace-id');
      expect(receivedParams?._meta).toHaveProperty('custom', 'safe');
    });
  });

  describe('_meta sanitization', () => {
    it('strips auth-like keys from _meta before forwarding to upstream', async () => {
      const upstream = getUpstreamServer();
      let receivedParams: Record<string, unknown> | undefined;
      upstream.fallbackRequestHandler = async (request) => {
        receivedParams = request.params as Record<string, unknown>;
        return { result: 'ok' };
      };

      await endClient.request(
        {
          method: 'test/meta',
          params: {
            _meta: {
              authorization: 'Bearer secret',
              token: 'abc',
              traceparent: '00-trace-id',
              custom: 'allowed',
            },
            data: 'hello',
          },
        } as Parameters<typeof endClient.request>[0],
        permissiveSchema,
      );

      expect(receivedParams?._meta).not.toHaveProperty('authorization');
      expect(receivedParams?._meta).not.toHaveProperty('token');
      expect(receivedParams?._meta).toHaveProperty('traceparent', '00-trace-id');
      expect(receivedParams?._meta).toHaveProperty('custom', 'allowed');
    });
  });

  describe('sanitizeMeta edge cases', () => {
    it('passes through params without _meta unchanged', async () => {
      const upstream = getUpstreamServer();
      let receivedParams: Record<string, unknown> | undefined;
      upstream.fallbackRequestHandler = async (request) => {
        receivedParams = request.params as Record<string, unknown>;
        return { result: 'ok' };
      };

      await endClient.request(
        {
          method: 'test/nometa',
          params: { data: 'value' },
        } as Parameters<typeof endClient.request>[0],
        permissiveSchema,
      );

      expect(receivedParams).toHaveProperty('data', 'value');
      expect(receivedParams).not.toHaveProperty('_meta');
    });

    it('keeps non-auth keys in _meta', async () => {
      const upstream = getUpstreamServer();
      let receivedParams: Record<string, unknown> | undefined;
      upstream.fallbackRequestHandler = async (request) => {
        receivedParams = request.params as Record<string, unknown>;
        return { result: 'ok' };
      };

      await endClient.request(
        {
          method: 'test/safemeta',
          params: {
            _meta: { requestId: '123', progressToken: 'abc' },
            data: 'value',
          },
        } as Parameters<typeof endClient.request>[0],
        permissiveSchema,
      );

      expect(receivedParams?._meta).toHaveProperty('requestId', '123');
      expect(receivedParams?._meta).toHaveProperty('progressToken', 'abc');
    });
  });

  describe('close', () => {
    it('shuts down cleanly', async () => {
      await expect(proxyHandle.close()).resolves.not.toThrow();
    });
  });

  describe('Reconnection', () => {
    it('reconnects when remote server disconnects', async () => {
      const initialConnectCount = connectCount;

      // Close the upstream server to simulate remote disconnect
      const upstream = getUpstreamServer();
      await upstream.close();

      // Wait for reconnection to happen
      await new Promise((r) => setTimeout(r, 300));

      // Should have created a new connection
      expect(connectCount).toBeGreaterThan(initialConnectCount);
    });

    it('requests work after reconnection', async () => {
      // Close the upstream to trigger reconnect
      const oldUpstream = getUpstreamServer();
      await oldUpstream.close();

      // Wait for reconnection
      await new Promise((r) => setTimeout(r, 300));

      // The new upstream should be serving requests
      const newUpstream = getUpstreamServer();
      newUpstream.fallbackRequestHandler = async (request) => {
        if (request.method === 'tools/list') {
          return {
            tools: [
              { name: 'reconnected-tool', description: 'After reconnect', inputSchema: { type: 'object' as const } },
            ],
          };
        }
        return {};
      };

      const result = await endClient.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('reconnected-tool');
    });

    it('preserves client identity after reconnection', async () => {
      const oldUpstream = getUpstreamServer();
      await oldUpstream.close();

      await new Promise((r) => setTimeout(r, 300));

      const newUpstream = getUpstreamServer();
      const clientInfo = newUpstream.getClientVersion();
      expect(clientInfo?.name).toBe('test-client via mcp-client-credentials-auth v0.1.0');
      expect(clientInfo?.version).toBe('2.5.0');
    });

    it('preserves client capabilities after reconnection', async () => {
      const oldUpstream = getUpstreamServer();
      await oldUpstream.close();

      await new Promise((r) => setTimeout(r, 300));

      const newUpstream = getUpstreamServer();
      const clientCaps = newUpstream.getClientCapabilities();
      expect(clientCaps?.sampling).toBeDefined();
      expect(clientCaps?.roots).toBeDefined();
    });

    it('does not trigger reconnection during intentional close', async () => {
      const countBefore = connectCount;
      await proxyHandle.close();

      await new Promise((r) => setTimeout(r, 200));

      // close() sets reconnecting=true, so onclose should NOT trigger a reconnect
      // Only the close itself should have run, no new connections
      expect(connectCount).toBe(countBefore);
    });
  });
});

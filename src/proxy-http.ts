import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { ProxyHandle } from './proxy-handle.js';
import { createProxySession, type ProxySession } from './proxy-session.js';
import { discoverRemoteMcp } from './remote-mcp-discovery.js';
import type { TokenManager } from './token-manager.js';

interface HttpSessionEntry {
  transport: StreamableHTTPServerTransport;
  session: ProxySession;
  lastActiveAt: number;
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export async function createHttpProxy(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
  /** Absolute deadline (Date.now()-based) for Phase 1 remote readiness; defaults to now + startupTimeoutMs. */
  startupDeadlineMs: number = Date.now() + config.startupTimeoutMs,
): Promise<ProxyHandle> {
  const discovery = await discoverRemoteMcp(config, tokenManager, logger, startupDeadlineMs);

  const app = createMcpExpressApp({ host: config.listenHost });
  const sessions = new Map<string, HttpSessionEntry>();
  let closingIntentionally = false;
  let idleSweepTimer: ReturnType<typeof setInterval> | undefined;

  // Kubernetes-style probes: process up only (no IdP / remote MCP checks).
  app.get('/health/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', (_req: Request, res: Response) => {
    if (closingIntentionally) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    res.status(200).json({ status: 'ok' });
  });

  function touchSession(entry: HttpSessionEntry): void {
    entry.lastActiveAt = Date.now();
  }

  /**
   * Close a session that was already removed from `sessions` (or never inserted).
   * `transport.close()` fires onclose, which calls `session.close()` again; that is idempotent enough.
   */
  function teardownSession(entry: HttpSessionEntry): void {
    void entry.transport.close().catch(() => {});
  }

  function evictIdleSessions(): void {
    if (config.httpSessionIdleSeconds <= 0 || closingIntentionally) return;
    const idleMs = config.httpSessionIdleSeconds * 1000;
    const now = Date.now();
    const staleIds: string[] = [];
    for (const [id, entry] of sessions) {
      if (now - entry.lastActiveAt >= idleMs) {
        staleIds.push(id);
      }
    }
    for (const id of staleIds) {
      const entry = sessions.get(id);
      if (!entry) continue;
      sessions.delete(id);
      logger.info('HTTP MCP session idle timeout', {
        sessionId: id,
        idleSeconds: config.httpSessionIdleSeconds,
        activeSessions: sessions.size,
      });
      teardownSession(entry);
    }
  }

  function startIdleSweep(): void {
    if (idleSweepTimer || config.httpSessionIdleSeconds <= 0) return;
    const idleMs = config.httpSessionIdleSeconds * 1000;
    // Notice soon after the idle deadline; floor 1s (tests), cap 30s.
    const sweepMs = Math.min(30_000, Math.max(1_000, Math.floor(idleMs / 6)));
    idleSweepTimer = setInterval(() => {
      evictIdleSessions();
    }, sweepMs);
    idleSweepTimer.unref?.();
    logger.info('HTTP session idle sweep started', {
      idleSeconds: config.httpSessionIdleSeconds,
      sweepIntervalMs: sweepMs,
    });
  }

  function stopIdleSweep(): void {
    if (idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = undefined;
    }
  }

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        touchSession(entry);
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        const localSessionId: { current?: string } = {};
        const session = createProxySession(config, tokenManager, logger, {
          discoveredCapabilities: discovery.capabilities,
          remoteServerInfo: discovery.serverInfo,
          onLocalDisconnect: 'close',
          localSessionId,
        });

        // Assigned in onsessioninitialized after connect; closed over by transport handlers.
        let entry: HttpSessionEntry | undefined;

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            localSessionId.current = id;
            if (!entry) {
              entry = { transport, session, lastActiveAt: Date.now() };
            }
            touchSession(entry);
            sessions.set(id, entry);
            logger.info('HTTP MCP session created', {
              sessionId: id,
              activeSessions: sessions.size,
            });
          },
        });

        entry = { transport, session, lastActiveAt: Date.now() };

        // Guard against close → localServer.close → transport.close → onclose recursion.
        let sessionTeardownStarted = false;
        transport.onclose = () => {
          if (sessionTeardownStarted) return;
          sessionTeardownStarted = true;
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            logger.info('HTTP MCP session transport closed', {
              sessionId: sid,
              activeSessions: sessions.size,
            });
          } else {
            logger.info(
              'HTTP MCP session transport closed',
              sid
                ? { sessionId: sid, activeSessions: sessions.size }
                : { activeSessions: sessions.size },
            );
          }
          // Always tear down the session (including half-init before sessionId is assigned).
          if (!closingIntentionally) {
            void session.close().catch(() => {});
          }
        };

        await session.localServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        // Evicted/unknown id: client must re-initialize without mcp-session-id (not auto-created here).
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }

      sendJsonRpcError(res, 400, -32000, 'Bad Request: Session ID required');
    } catch (err) {
      logger.warn('HTTP MCP request failed', {
        category: 'connection',
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  }

  const mcpPath = config.listenPath;
  for (const method of ['post', 'get', 'delete'] as const) {
    app[method](mcpPath, (req, res) => {
      void handleMcpRequest(req, res);
    });
  }

  const httpServer: HttpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.listenPort, config.listenHost, () => {
      resolve(server);
    });
    server.on('error', reject);
  });

  const address = httpServer.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : config.listenPort;

  startIdleSweep();

  logger.info('Local MCP server started on Streamable HTTP', {
    host: config.listenHost,
    port: boundPort,
    path: config.listenPath,
    httpSessionIdleSeconds: config.httpSessionIdleSeconds,
  });

  return {
    listenPort: boundPort,
    async close() {
      logger.info('Shutting down HTTP proxy');
      // Flip readiness first so probes can observe 503 before the listener stops.
      closingIntentionally = true;
      stopIdleSweep();
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.all(entries.map(async (entry) => {
        try {
          await entry.session.close();
        } catch {
          // ignore
        }
        try {
          await entry.transport.close();
        } catch {
          // ignore
        }
      }));
      // Brief drain so load-balancer readiness probes can see shutting_down.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

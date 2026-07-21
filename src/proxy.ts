import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ClientCapabilities, Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v3';
import type { Config } from './config.js';
import {
  PROXY_NAME,
  classifyError,
  errorDetail,
  formatUnrecoverableOAuthMisconfig,
  isStaleRemoteSessionError,
  resolveUnrecoverableStartupAuthSource,
  toClientError,
  wrapCaughtError,
} from './errors.js';
import type { Logger } from './logger.js';
import type { TokenManager } from './token-manager.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };
export const PKG_VERSION = pkg.version;
const CLIENT_CREDENTIALS_EXTENSION = 'io.modelcontextprotocol/oauth-client-credentials';

const permissiveSchema = z.object({}).passthrough();

const AUTH_META_KEYS = new Set([
  'authorization',
  'token',
  'bearer',
  'access_token',
  'client_secret',
]);

function sanitizeMeta(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params;
  const meta = params._meta;
  if (!meta || typeof meta !== 'object') return params;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (!AUTH_META_KEYS.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return { ...params, _meta: sanitized };
}

function withClientCredentialsExtension(capabilities: ClientCapabilities): ClientCapabilities {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [CLIENT_CREDENTIALS_EXTENSION]: {},
    },
  };
}

function buildClientIdentity(localClientInfo: Implementation | undefined): Implementation {
  if (localClientInfo?.name) {
    return {
      name: `${localClientInfo.name} via ${PROXY_NAME} v${PKG_VERSION}`,
      version: localClientInfo.version ?? '',
    };
  }
  return { name: PROXY_NAME, version: PKG_VERSION };
}

/** SSE uses the same authProvider; only retry on transport-shaped failures. */
function shouldFallbackToSse(err: unknown): boolean {
  return classifyError(err) === 'connection';
}

export interface ProxyHandle {
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function createProxy(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
  /** Absolute deadline (Date.now()-based) for Phase 1 remote readiness; defaults to now + startupTimeoutMs. */
  startupDeadlineMs: number = Date.now() + config.startupTimeoutMs,
): Promise<ProxyHandle> {
  const remoteUrl = new URL(config.remoteMcpUrl);

  // --- Phase 1: Required discovery connection (retry until shared startup deadline) ---
  let discoveredCapabilities: ServerCapabilities = {};
  let remoteServerInfo: Implementation | undefined;

  const PHASE1_RETRY_BASE_MS = 1000;
  const PHASE1_RETRY_MAX_MS = 60000;

  async function connectDiscoveryClient(): Promise<{
    capabilities: ServerCapabilities;
    serverInfo: Implementation | undefined;
  }> {
    const authProvider = tokenManager.getAuthProvider();
    const discoveryClient = new Client(
      { name: PROXY_NAME, version: PKG_VERSION },
      { capabilities: withClientCredentialsExtension({}) },
    );

    try {
      const httpTransport = new StreamableHTTPClientTransport(remoteUrl, {
        authProvider,
      });
      await discoveryClient.connect(httpTransport);
      logger.info('Discovery: connected via Streamable HTTP');
    } catch (httpErr) {
      const detail = errorDetail(httpErr);
      const category = classifyError(httpErr);
      if (!shouldFallbackToSse(httpErr)) {
        logger.warn('Streamable HTTP connection failed, not trying SSE fallback', {
          category,
          error: detail,
        });
        throw httpErr;
      }
      logger.warn('Streamable HTTP connection failed, trying SSE fallback', {
        category,
        error: detail,
      });
      const sseTransport = new SSEClientTransport(remoteUrl, {
        authProvider,
      });
      await discoveryClient.connect(sseTransport);
      logger.info('Discovery: connected to remote MCP server via SSE');
    }

    const capabilities = discoveryClient.getServerCapabilities() ?? {};
    const serverInfo = discoveryClient.getServerVersion();
    await discoveryClient.close();
    logger.debug('Discovery connection closed');
    return { capabilities, serverInfo };
  }

  let phase1Attempt = 0;
  while (true) {
    logger.info('Connecting to remote MCP server for discovery', {
      url: config.remoteMcpUrl,
      attempt: phase1Attempt + 1,
    });
    try {
      const result = await connectDiscoveryClient();
      discoveredCapabilities = result.capabilities;
      remoteServerInfo = result.serverInfo;
      break;
    } catch (err) {
      const detail = errorDetail(err);
      const category = classifyError(err);
      const authFailureSource = resolveUnrecoverableStartupAuthSource(err);
      if (authFailureSource) {
        const message = formatUnrecoverableOAuthMisconfig(detail, authFailureSource);
        logger.error(message, {
          category: 'authentication',
          unrecoverable: true,
          failureSource: authFailureSource,
          error: detail,
        });
        throw new Error(message, { cause: err });
      }
      const remaining = startupDeadlineMs - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Remote MCP server unreachable within startup timeout: ${detail}`,
          { cause: err },
        );
      }
      const exponential = Math.min(PHASE1_RETRY_BASE_MS * 2 ** phase1Attempt, PHASE1_RETRY_MAX_MS);
      const jitter = Math.random() * exponential * 0.3;
      const delayMs = Math.min(Math.round(exponential + jitter), remaining);
      logger.warn('Remote MCP server unreachable during discovery, retrying', {
        category,
        error: detail,
        attempt: phase1Attempt + 1,
        delayMs,
        remainingMs: remaining,
      });
      await sleep(delayMs);
      phase1Attempt++;
    }
  }

  // --- Phase 2: Create local server with discovered info ---
  const localServer = new Server(
    remoteServerInfo ?? { name: PROXY_NAME, version: PKG_VERSION },
    { capabilities: { ...discoveredCapabilities } },
  );

  // --- Phase 3: Reconnect with real client identity after local handshake ---
  let remoteClient: Client | undefined;
  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });

  async function connectRemote(
    identity: Implementation,
    capabilities: ClientCapabilities,
  ): Promise<Client> {
    const authProvider = tokenManager.getAuthProvider();
    logger.debug('Connecting to remote MCP server', { clientName: identity.name });
    const client = new Client(identity, {
      capabilities: withClientCredentialsExtension(capabilities),
    });

    try {
      const httpTransport = new StreamableHTTPClientTransport(remoteUrl, {
        authProvider,
      });
      await client.connect(httpTransport);
      logger.info('Connected to remote MCP server via Streamable HTTP', {
        clientName: identity.name,
      });
    } catch (httpErr) {
      const detail = errorDetail(httpErr);
      const category = classifyError(httpErr);
      if (!shouldFallbackToSse(httpErr)) {
        logger.warn('Streamable HTTP failed, not trying SSE fallback', {
          category,
          error: detail,
        });
        throw httpErr;
      }
      logger.warn('Streamable HTTP failed, trying SSE fallback', {
        category,
        error: detail,
      });
      const sseTransport = new SSEClientTransport(remoteUrl, {
        authProvider,
      });
      await client.connect(sseTransport);
      logger.info('Connected to remote MCP server via SSE', {
        clientName: identity.name,
      });
    }

    return client;
  }

  function wireRemoteHandlers(client: Client): void {
    client.fallbackNotificationHandler = async (notification) => {
      logger.debug('Forwarding server notification', { method: notification.method });
      await localServer.notification({
        method: notification.method,
        params: notification.params,
      });
    };

    client.fallbackRequestHandler = async (request) => {
      logger.debug('Forwarding server request to local client', { method: request.method });
      return localServer.request(
        { method: request.method, params: request.params },
        permissiveSchema,
      );
    };
  }

  function checkCapabilityChanges(newCaps: ServerCapabilities): void {
    const oldKeys = Object.keys(discoveredCapabilities);
    const newKeys = Object.keys(newCaps);
    const added = newKeys.filter((k) => !oldKeys.includes(k));
    const removed = oldKeys.filter((k) => !newKeys.includes(k));

    if (added.length > 0 || removed.length > 0) {
      logger.warn(
        'Remote server top-level capabilities changed after reconnection; ' +
        'these changes cannot be propagated mid-session (client reconnect needed)',
        { added, removed },
      );
    }
  }

  async function notifyListChanges(caps: ServerCapabilities): Promise<void> {
    try {
      if (caps.tools) await localServer.sendToolListChanged();
      if (caps.resources) await localServer.sendResourceListChanged();
      if (caps.prompts) await localServer.sendPromptListChanged();
    } catch (err) {
      logger.warn('Failed to send list changed notifications', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let storedIdentity: Implementation | undefined;
  let storedCapabilities: ClientCapabilities | undefined;
  let reconnecting = false;
  let closingIntentionally = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectPromise: Promise<void> | undefined;
  let sessionRecoveryPromise: Promise<boolean> | undefined;
  let lastStableConnect = 0;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 60000;
  const RECONNECT_STABLE_THRESHOLD_MS = 30000;

  function getReconnectDelay(): number {
    const exponential = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    const jitter = Math.random() * exponential * 0.3;
    return Math.round(exponential + jitter);
  }

  function scheduleReconnect(): Promise<void> {
    if (!reconnectPromise) {
      reconnectPromise = reconnect().finally(() => {
        reconnectPromise = undefined;
      });
    }
    return reconnectPromise;
  }

  function wireOnClose(client: Client): void {
    client.onclose = () => {
      if (reconnecting || closingIntentionally) return;
      if (lastStableConnect > 0 && Date.now() - lastStableConnect > RECONNECT_STABLE_THRESHOLD_MS) {
        reconnectAttempt = 0;
      }
      logger.warn('Remote connection lost, attempting reconnection');
      void scheduleReconnect();
    };
  }

  /** Wire handlers, notify list changes, and start polling for a newly connected remote client. */
  async function adoptRemoteClient(client: Client): Promise<void> {
    remoteClient = client;
    wireRemoteHandlers(client);
    wireOnClose(client);

    const newCaps = client.getServerCapabilities() ?? {};
    checkCapabilityChanges(newCaps);
    await notifyListChanges(newCaps);
    startPolling();
  }

  /**
   * Clear the current remote client and stop polling.
   * `close: true` closes the transport (stale-session path; onclose is suppressed via reconnecting).
   * `holdReconnecting: true` leaves reconnecting=true for the caller (reconnect path).
   */
  async function dropRemoteClient(options: {
    close: boolean;
    holdReconnecting?: boolean;
  }): Promise<void> {
    reconnecting = true;
    stopPolling();
    const previous = remoteClient;
    remoteClient = undefined;
    if (options.close && previous) {
      try {
        await previous.close();
      } catch {
        // Stale transport close errors are expected after remote restart.
      }
    }
    if (!options.holdReconnecting) {
      reconnecting = false;
    }
  }

  async function reconnect(): Promise<void> {
    await dropRemoteClient({ close: false, holdReconnecting: true });

    if (!storedIdentity || !storedCapabilities) {
      logger.error('Cannot reconnect: no stored identity/capabilities');
      reconnecting = false;
      return;
    }

    if (reconnectAttempt > 0) {
      const delayMs = getReconnectDelay();
      logger.info('Scheduling reconnection attempt', {
        attempt: reconnectAttempt + 1,
        delayMs,
      });
      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(resolve, delayMs);
      });
    }

    if (closingIntentionally) {
      reconnecting = false;
      return;
    }

    logger.info('Attempting reconnection', { attempt: reconnectAttempt + 1 });
    try {
      const client = await connectRemote(storedIdentity, storedCapabilities);
      await adoptRemoteClient(client);
      lastStableConnect = Date.now();
      if (reconnectAttempt > 0) {
        logger.info('Reconnection successful', { afterAttempts: reconnectAttempt + 1 });
      } else {
        logger.info('Reconnection successful');
      }
      reconnectAttempt = 0;
    } catch (err) {
      const detail = errorDetail(err);
      const category = classifyError(err);
      logger.warn('Reconnection failed, will retry', {
        category,
        error: detail,
        attempt: reconnectAttempt + 1,
      });
      remoteClient = undefined;
      reconnectAttempt++;
      reconnecting = false;
      // Schedule the next attempt after this coalesced promise settles (avoid nested await deadlock).
      queueMicrotask(() => {
        if (!closingIntentionally && !remoteClient) {
          void scheduleReconnect();
        }
      });
      return;
    } finally {
      reconnecting = false;
    }
  }

  /**
   * Drop a live-but-stale Streamable HTTP session and reconnect (new initialize / session id).
   * Concurrent callers share one recovery; logs the session lost / reacquired pair once.
   */
  function recoverStaleRemoteSession(options: {
    method?: string;
    error: unknown;
  }): Promise<boolean> {
    if (!sessionRecoveryPromise) {
      sessionRecoveryPromise = (async () => {
        logger.warn('Remote Streamable HTTP session lost, recreating session', {
          category: 'connection',
          ...(options.method !== undefined ? { method: options.method } : {}),
          error: errorDetail(options.error),
        });

        if (remoteClient) {
          await dropRemoteClient({ close: true });
        }

        await scheduleReconnect();

        if (remoteClient) {
          logger.info('Remote Streamable HTTP session reacquired');
          return true;
        }

        logger.warn('Failed to reacquire remote Streamable HTTP session, will keep retrying', {
          category: 'connection',
        });
        return false;
      })().finally(() => {
        sessionRecoveryPromise = undefined;
      });
    }
    return sessionRecoveryPromise;
  }

  localServer.oninitialized = () => {
    const localClientInfo = localServer.getClientVersion();
    const localClientCaps = localServer.getClientCapabilities() ?? {};

    const identity = buildClientIdentity(localClientInfo);
    const capabilities = localClientCaps;

    storedIdentity = identity;
    storedCapabilities = capabilities;

    logger.info('Local client initialized', {
      clientName: localClientInfo?.name,
      clientVersion: localClientInfo?.version,
      resolvedRemoteName: identity.name,
    });

    void (async () => {
      try {
        const client = await connectRemote(identity, capabilities);
        await adoptRemoteClient(client);
        readyResolve();
      } catch (err) {
        const detail = errorDetail(err);
        const category = classifyError(err);
        logger.warn('Failed to establish real remote connection, scheduling reconnection', {
          category,
          error: detail,
        });
        readyResolve();
        void scheduleReconnect();
      }
    })();
  };

  async function forwardRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    if (!remoteClient) {
      throw toClientError('connection', 'temporarily unavailable (reconnecting)');
    }
    return remoteClient.request(
      { method, params },
      permissiveSchema,
      { timeout: config.requestTimeoutMs },
    );
  }

  // Flow 1: Client->Server REQUESTS
  localServer.fallbackRequestHandler = async (request) => {
    await readyPromise;

    const authMode = tokenManager.getAuthMode();
    if (authMode.type === 'authenticated' && !tokenManager.hasUsableAccessToken()) {
      logger.warn('Rejecting request: no usable access token', {
        category: 'authentication',
        method: request.method,
      });
      throw toClientError('authentication', 'no usable access token');
    }

    const sanitizedParams = sanitizeMeta(request.params);

    try {
      return await forwardRequest(request.method, sanitizedParams);
    } catch (err) {
      if (isStaleRemoteSessionError(err)) {
        const recovered = await recoverStaleRemoteSession({
          method: request.method,
          error: err,
        });
        if (recovered) {
          try {
            return await forwardRequest(request.method, sanitizedParams);
          } catch (retryErr) {
            const category = classifyError(retryErr);
            logger.warn('Remote request failed after session reacquire', {
              category,
              method: request.method,
              error: errorDetail(retryErr),
            });
            throw wrapCaughtError(retryErr);
          }
        }
        throw toClientError('connection', 'temporarily unavailable (reconnecting)');
      }

      const category = classifyError(err);
      logger.warn('Remote request failed', {
        category,
        method: request.method,
        error: errorDetail(err),
      });
      throw wrapCaughtError(err);
    }
  };

  // Flow 4: Client->Server NOTIFICATIONS
  localServer.fallbackNotificationHandler = async (notification) => {
    await readyPromise;
    if (!remoteClient) return;
    logger.debug('Forwarding client notification', { method: notification.method });
    const sanitizedParams = sanitizeMeta(notification.params);
    await remoteClient.notification({
      method: notification.method,
      params: sanitizedParams,
    });
  };

  const stdioTransport = new StdioServerTransport();
  await localServer.connect(stdioTransport);
  logger.info('Local MCP server started on stdio');

  localServer.onclose = () => {
    if (closingIntentionally) return;
    logger.info('Local client disconnected, shutting down');
    closingIntentionally = true;
    reconnecting = true;
    stopPolling();
    if (remoteClient) {
      const client = remoteClient;
      Promise.race([
        client.close(),
        new Promise((r) => setTimeout(r, 2000)),
      ]).catch(() => {}).finally(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  // Capabilities polling
  let pollInterval: ReturnType<typeof setInterval> | undefined;

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = undefined;
    }
  }

  function startPolling(): void {
    if (config.capabilitiesPollSeconds <= 0) return;
    if (pollInterval) return;

    let lastToolsHash = '';
    let lastResourcesHash = '';
    let lastPromptsHash = '';

    const pollCapabilities = async () => {
      if (!remoteClient) return;
      try {
        const caps = remoteClient.getServerCapabilities() ?? {};
        const client = remoteClient;

        const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
          caps.tools ? client.listTools() : undefined,
          caps.resources ? client.listResources() : undefined,
          caps.prompts ? client.listPrompts() : undefined,
        ]);

        if (toolsResult) {
          const hash = JSON.stringify(toolsResult.tools);
          if (lastToolsHash && hash !== lastToolsHash) {
            logger.info('Remote tools changed, notifying local client');
            await localServer.sendToolListChanged();
          }
          lastToolsHash = hash;
        }

        if (resourcesResult) {
          const hash = JSON.stringify(resourcesResult.resources);
          if (lastResourcesHash && hash !== lastResourcesHash) {
            logger.info('Remote resources changed, notifying local client');
            await localServer.sendResourceListChanged();
          }
          lastResourcesHash = hash;
        }

        if (promptsResult) {
          const hash = JSON.stringify(promptsResult.prompts);
          if (lastPromptsHash && hash !== lastPromptsHash) {
            logger.info('Remote prompts changed, notifying local client');
            await localServer.sendPromptListChanged();
          }
          lastPromptsHash = hash;
        }
      } catch (err) {
        const detail = errorDetail(err);
        const category = classifyError(err);
        logger.warn('Capabilities poll failed', {
          category,
          error: detail,
        });
        if (isStaleRemoteSessionError(err)) {
          void recoverStaleRemoteSession({ error: err });
        }
      }
    };

    void pollCapabilities();
    pollInterval = setInterval(
      () => void pollCapabilities(),
      config.capabilitiesPollSeconds * 1000,
    );
    logger.info('Capabilities polling started', {
      intervalSeconds: config.capabilitiesPollSeconds,
    });
  }

  return {
    async close() {
      logger.info('Shutting down proxy');
      closingIntentionally = true;
      reconnecting = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      stopPolling();
      await localServer.close();
      if (remoteClient) {
        await remoteClient.close();
      }
    },
  };
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ClientCapabilities, Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v3';
import { getBackoffDelay } from './backoff.js';
import type { Config } from './config.js';
import {
  PROXY_NAME,
  classifyError,
  errorDetail,
  isStaleRemoteSessionError,
  toClientError,
  wrapCaughtError,
} from './errors.js';
import type { Logger } from './logger.js';
import { connectWithTransportFallback } from './remote-connect.js';
import type { TokenManager } from './token-manager.js';
import {
  PKG_VERSION,
  buildClientIdentity,
  sanitizeMeta,
  withClientCredentialsExtension,
} from './proxy-utils.js';

const permissiveSchema = z.object({}).passthrough();

export interface ProxySession {
  localServer: Server;
  close(): Promise<void>;
}

export interface CreateProxySessionOptions {
  discoveredCapabilities: ServerCapabilities;
  remoteServerInfo: Implementation | undefined;
  /**
   * `exit` — stdin/local close shuts down the process (stdio mode).
   * `close` — tear down this session only; keep the process up (HTTP mode).
   */
  onLocalDisconnect: 'exit' | 'close';
}

export function createProxySession(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
  options: CreateProxySessionOptions,
): ProxySession {
  const remoteUrl = new URL(config.remoteMcpUrl);
  const discoveredCapabilities = options.discoveredCapabilities;

  const localServer = new Server(
    options.remoteServerInfo ?? { name: PROXY_NAME, version: PKG_VERSION },
    { capabilities: { ...discoveredCapabilities } },
  );

  let remoteClient: Client | undefined;
  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });

  async function connectRemote(
    identity: Implementation,
    capabilities: ClientCapabilities,
  ): Promise<Client> {
    logger.debug('Connecting to remote MCP server', { clientName: identity.name });
    const client = new Client(identity, {
      capabilities: withClientCredentialsExtension(capabilities),
    });

    await connectWithTransportFallback(client, remoteUrl, {
      authProvider: tokenManager.getAuthProvider(),
      fetch: tokenManager.getScopeStepUpFetch(),
      logger,
      phase: 'runtime',
      clientName: identity.name,
    });

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
      const delayMs = getBackoffDelay(reconnectAttempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
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
      void tokenManager.rediscoverOAuthMetadata();
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

  localServer.onclose = () => {
    if (closingIntentionally) return;
    if (options.onLocalDisconnect === 'exit') {
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
      return;
    }

    logger.info('Local MCP session closed');
    closingIntentionally = true;
    reconnecting = true;
    stopPolling();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (remoteClient) {
      const client = remoteClient;
      remoteClient = undefined;
      void client.close().catch(() => {});
    }
  };

  // Capabilities polling
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let pollStartTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInflight = false;

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = undefined;
    }
    if (pollStartTimer) {
      clearTimeout(pollStartTimer);
      pollStartTimer = undefined;
    }
  }

  function startPolling(): void {
    if (config.capabilitiesPollSeconds <= 0) return;
    if (pollInterval || pollStartTimer) return;

    let lastToolsHash = '';
    let lastResourcesHash = '';
    let lastPromptsHash = '';
    const intervalMs = config.capabilitiesPollSeconds * 1000;
    const requestTimeout = { timeout: config.requestTimeoutMs };

    const pollCapabilities = async () => {
      if (!remoteClient || pollInflight) return;
      pollInflight = true;
      try {
        const caps = remoteClient.getServerCapabilities() ?? {};
        const client = remoteClient;

        const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
          caps.tools ? client.listTools(undefined, requestTimeout) : undefined,
          caps.resources ? client.listResources(undefined, requestTimeout) : undefined,
          caps.prompts ? client.listPrompts(undefined, requestTimeout) : undefined,
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
      } finally {
        pollInflight = false;
      }
    };

    // Jitter the first tick so multi-session HTTP creates do not align on the same wall clock.
    const jitterMs = Math.floor(Math.random() * Math.min(intervalMs, 5000));
    pollStartTimer = setTimeout(() => {
      pollStartTimer = undefined;
      void pollCapabilities();
      pollInterval = setInterval(() => void pollCapabilities(), intervalMs);
    }, jitterMs);
    logger.info('Capabilities polling started', {
      intervalSeconds: config.capabilitiesPollSeconds,
      firstPollJitterMs: jitterMs,
    });
  }

  return {
    localServer,
    async close() {
      logger.info('Shutting down proxy session');
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

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
import type { Logger } from './logger.js';
import type { TokenManager } from './token-manager.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };
export const PKG_VERSION = pkg.version;
const PROXY_NAME = 'mcp-client-credentials-auth';

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

function buildClientIdentity(localClientInfo: Implementation | undefined): Implementation {
  if (localClientInfo?.name) {
    return {
      name: `${localClientInfo.name} via ${PROXY_NAME} v${PKG_VERSION}`,
      version: localClientInfo.version ?? '',
    };
  }
  return { name: PROXY_NAME, version: PKG_VERSION };
}

export interface ProxyHandle {
  close(): Promise<void>;
}

export async function createProxy(
  config: Config,
  tokenManager: TokenManager,
  logger: Logger,
): Promise<ProxyHandle> {
  const authProvider = tokenManager.getAuthProvider();
  const remoteUrl = new URL(config.remoteMcpUrl);

  // --- Phase 1: Discovery connection ---
  const discoveryClient = new Client(
    { name: PROXY_NAME, version: PKG_VERSION },
    { capabilities: {} },
  );

  logger.info('Connecting to remote MCP server for discovery', { url: config.remoteMcpUrl });
  try {
    const httpTransport = new StreamableHTTPClientTransport(remoteUrl, {
      authProvider,
      ...(config.requestTimeoutMs
        ? { requestInit: { signal: AbortSignal.timeout(config.requestTimeoutMs) } }
        : {}),
    });
    await discoveryClient.connect(httpTransport);
    logger.info('Discovery: connected via Streamable HTTP');
  } catch (httpErr) {
    logger.info('Streamable HTTP connection failed, trying SSE fallback', {
      error: httpErr instanceof Error ? httpErr.message : String(httpErr),
    });
    try {
      const sseTransport = new SSEClientTransport(remoteUrl, {
        authProvider,
        ...(config.requestTimeoutMs
          ? { requestInit: { signal: AbortSignal.timeout(config.requestTimeoutMs) } }
          : {}),
      });
      await discoveryClient.connect(sseTransport);
      logger.info('Discovery: connected to remote MCP server via SSE');
    } catch (sseErr) {
      logger.error('Failed to connect to remote MCP server', {
        httpError: httpErr instanceof Error ? httpErr.message : String(httpErr),
        sseError: sseErr instanceof Error ? sseErr.message : String(sseErr),
      });
      throw new Error(
        `Cannot connect to remote MCP server at ${config.remoteMcpUrl}: ${sseErr instanceof Error ? sseErr.message : String(sseErr)}`,
        { cause: sseErr },
      );
    }
  }

  const discoveredCapabilities: ServerCapabilities = discoveryClient.getServerCapabilities() ?? {};
  const remoteServerInfo = discoveryClient.getServerVersion();
  await discoveryClient.close();
  logger.debug('Discovery connection closed');

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
    logger.debug('Connecting to remote MCP server', { clientName: identity.name });
    const client = new Client(identity, { capabilities });

    try {
      const httpTransport = new StreamableHTTPClientTransport(remoteUrl, {
        authProvider,
        ...(config.requestTimeoutMs
          ? { requestInit: { signal: AbortSignal.timeout(config.requestTimeoutMs) } }
          : {}),
      });
      await client.connect(httpTransport);
      logger.info('Connected to remote MCP server via Streamable HTTP', {
        clientName: identity.name,
      });
    } catch (httpErr) {
      logger.info('Streamable HTTP failed, trying SSE fallback', {
        error: httpErr instanceof Error ? httpErr.message : String(httpErr),
      });
      const sseTransport = new SSEClientTransport(remoteUrl, {
        authProvider,
        ...(config.requestTimeoutMs
          ? { requestInit: { signal: AbortSignal.timeout(config.requestTimeoutMs) } }
          : {}),
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

  function wireOnClose(client: Client): void {
    client.onclose = () => {
      if (reconnecting) return;
      logger.warn('Remote connection lost, attempting reconnection');
      void reconnect();
    };
  }

  async function reconnect(): Promise<void> {
    reconnecting = true;
    stopPolling();
    remoteClient = undefined;

    if (!storedIdentity || !storedCapabilities) {
      logger.error('Cannot reconnect: no stored identity/capabilities');
      reconnecting = false;
      return;
    }

    try {
      remoteClient = await connectRemote(storedIdentity, storedCapabilities);
      wireRemoteHandlers(remoteClient);
      wireOnClose(remoteClient);

      const newCaps = remoteClient.getServerCapabilities() ?? {};
      checkCapabilityChanges(newCaps);
      await notifyListChanges(newCaps);

      startPolling();
      logger.info('Reconnection successful');
    } catch (err) {
      logger.error('Reconnection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      remoteClient = undefined;
    } finally {
      reconnecting = false;
    }
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
        remoteClient = await connectRemote(identity, capabilities);
        wireRemoteHandlers(remoteClient);
        wireOnClose(remoteClient);

        const newCaps = remoteClient.getServerCapabilities() ?? {};
        checkCapabilityChanges(newCaps);
        await notifyListChanges(newCaps);

        startPolling();
        readyResolve();
      } catch (err) {
        logger.error('Failed to establish real remote connection', {
          error: err instanceof Error ? err.message : String(err),
        });
        readyResolve();
      }
    })();
  };

  // Flow 1: Client->Server REQUESTS
  localServer.fallbackRequestHandler = async (request) => {
    await readyPromise;

    const authMode = tokenManager.getAuthMode();
    if (authMode.type === 'unsupported-grant') {
      throw new Error(authMode.message);
    }
    if (authMode.type === 'discovery-failed') {
      throw new Error(authMode.message);
    }

    if (!remoteClient) {
      throw new Error('Remote MCP server connection not available');
    }

    const sanitizedParams = sanitizeMeta(request.params);
    return remoteClient.request(
      { method: request.method, params: sanitizedParams },
      permissiveSchema,
      { timeout: config.requestTimeoutMs },
    );
  };

  // Flow 4: Client->Server NOTIFICATIONS
  localServer.fallbackNotificationHandler = async (notification) => {
    await readyPromise;
    if (!remoteClient) return;
    logger.debug('Forwarding client notification', { method: notification.method });
    await remoteClient.notification({
      method: notification.method,
      params: notification.params,
    });
  };

  const stdioTransport = new StdioServerTransport();
  await localServer.connect(stdioTransport);
  logger.info('Local MCP server started on stdio');

  let closingIntentionally = false;

  localServer.onclose = () => {
    if (closingIntentionally) return;
    logger.info('Local client disconnected, shutting down');
    reconnecting = true;
    stopPolling();
    if (remoteClient) {
      void remoteClient.close();
    }
    process.exit(0);
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
        logger.warn('Capabilities poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
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
      stopPolling();
      await localServer.close();
      if (remoteClient) {
        await remoteClient.close();
      }
    },
  };
}

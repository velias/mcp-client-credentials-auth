import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientCapabilities, Implementation } from '@modelcontextprotocol/sdk/types.js';
import { PROXY_NAME } from './errors.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };
export const PKG_VERSION = pkg.version;

const CLIENT_CREDENTIALS_EXTENSION = 'io.modelcontextprotocol/oauth-client-credentials';

const AUTH_META_KEYS = new Set([
  'authorization',
  'token',
  'bearer',
  'access_token',
  'client_secret',
]);

export function sanitizeMeta(
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

export function withClientCredentialsExtension(capabilities: ClientCapabilities): ClientCapabilities {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [CLIENT_CREDENTIALS_EXTENSION]: {},
    },
  };
}

export function buildClientIdentity(localClientInfo: Implementation | undefined): Implementation {
  if (localClientInfo?.name) {
    return {
      name: `${localClientInfo.name} via ${PROXY_NAME} v${PKG_VERSION}`,
      version: localClientInfo.version ?? '',
    };
  }
  return { name: PROXY_NAME, version: PKG_VERSION };
}

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const PROXY_NAME = 'mcp-client-credentials-auth';

export type ErrorCategory = 'authentication' | 'connection' | 'remote';

/** Where classifyError should assume UnauthorizedError originated. */
export type ClassifyContext = 'token' | 'transport';

const OAUTH_ERROR_CODE_KEY = 'errorCode';

function hasOAuthErrorCode(err: unknown): err is Error & { errorCode: string } {
  return (
    err instanceof Error &&
    OAUTH_ERROR_CODE_KEY in err &&
    typeof (err as { errorCode: unknown }).errorCode === 'string' &&
    (err as { errorCode: string }).errorCode.length > 0
  );
}

/** OAuth error codes that indicate a client/config mistake, not a transient IdP outage. */
const PERMANENT_OAUTH_CONFIG_ERROR_CODES = new Set([
  'invalid_scope',
  'invalid_client',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_request',
  'invalid_grant',
  'access_denied',
]);

/**
 * True when the IdP rejected the token request for a non-retryable configuration reason
 * (wrong scopes, bad client credentials, grant not allowed for this client, etc.).
 */
export function isPermanentOAuthConfigError(err: unknown): boolean {
  return hasOAuthErrorCode(err) && PERMANENT_OAUTH_CONFIG_ERROR_CODES.has(err.errorCode);
}

/**
 * True when startup should not retry because the access token path is misconfigured:
 * IdP permanent OAuth errors, or the remote MCP server rejecting the Bearer token
 * (`UnauthorizedError`, `invalid_token`, `insufficient_scope`).
 */
export function isUnrecoverableStartupAuthError(err: unknown): boolean {
  if (isPermanentOAuthConfigError(err)) {
    return true;
  }
  if (err instanceof UnauthorizedError) {
    return true;
  }
  if (hasOAuthErrorCode(err)) {
    return err.errorCode === 'invalid_token' || err.errorCode === 'insufficient_scope';
  }
  return false;
}

/** Where an unrecoverable startup auth failure was detected. */
export type UnrecoverableAuthFailureSource = 'idp' | 'mcp-server';

/**
 * Classify an unrecoverable startup auth error as IdP token rejection vs remote MCP token rejection.
 * Returns undefined when the error is not an unrecoverable startup auth failure.
 */
export function resolveUnrecoverableStartupAuthSource(
  err: unknown,
): UnrecoverableAuthFailureSource | undefined {
  if (isPermanentOAuthConfigError(err)) {
    return 'idp';
  }
  if (isUnrecoverableStartupAuthError(err)) {
    return 'mcp-server';
  }
  return undefined;
}

/**
 * Client/operator-facing message for permanent OAuth/auth misconfiguration at startup.
 * Detail should be a short IdP/SDK/remote error (e.g. "Invalid scopes: api.graphql"), not secrets.
 * `source` makes clear whether the IdP rejected the token request or the MCP server rejected the Bearer token.
 */
export function formatUnrecoverableOAuthMisconfig(
  detail: string,
  source: UnrecoverableAuthFailureSource,
): string {
  if (source === 'idp') {
    return formatProxyError(
      'authentication',
      `Unrecoverable OAuth misconfiguration at the identity provider (IdP): ${detail}. ` +
        'The IdP rejected the token request (not the MCP server). This cannot self-heal; ' +
        'contact your MCP server provider to correct client credentials, requested scopes ' +
        '(MCP_CC_PROXY_SCOPES), or IdP grants for this client.',
    );
  }
  return formatProxyError(
    'authentication',
    `Unrecoverable OAuth misconfiguration at the remote MCP server: ${detail}. ` +
      'The MCP server rejected the access token after it was issued (not an IdP token-request failure). ' +
      'This cannot self-heal; contact your MCP server provider to correct token validation, ' +
      'required scopes/audience, or the credentials issued for this client.',
  );
}

export function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a failure by layer: IdP token acquisition, transport, or remote MCP response.
 */
export function classifyError(
  err: unknown,
  context: ClassifyContext = 'transport',
): ErrorCategory {
  if (err instanceof McpError) {
    return 'remote';
  }
  if (hasOAuthErrorCode(err)) {
    return 'authentication';
  }
  if (err instanceof UnauthorizedError) {
    return context === 'token' ? 'authentication' : 'remote';
  }
  return 'connection';
}

export function formatProxyError(category: ErrorCategory, detail: string): string {
  return `${PROXY_NAME} [${category}]: ${detail}`;
}

function isAlreadyFormatted(message: string): boolean {
  return message.startsWith(`${PROXY_NAME} [`);
}

export interface ToClientErrorOptions {
  /** Original error; for remote McpError, preserves JSON-RPC code and nests data. */
  cause?: unknown;
}

/**
 * Build a client-facing McpError with a consistent proxy prefix and category.
 * Accepts either a raw detail string or an already-formatted proxy message.
 */
export function toClientError(
  category: ErrorCategory,
  detailOrFormatted: string,
  options?: ToClientErrorOptions,
): McpError {
  const message = isAlreadyFormatted(detailOrFormatted)
    ? detailOrFormatted
    : formatProxyError(category, detailOrFormatted);

  if (category === 'remote' && options?.cause instanceof McpError) {
    return new McpError(options.cause.code, message, {
      source: PROXY_NAME,
      category,
      remote: options.cause.data,
    });
  }

  return new McpError(ErrorCode.InternalError, message, {
    source: PROXY_NAME,
    category,
  });
}

/**
 * Classify an unknown failure and wrap it for the local MCP client.
 */
export function wrapCaughtError(
  err: unknown,
  context: ClassifyContext = 'transport',
): McpError {
  const category = classifyError(err, context);
  return toClientError(category, errorDetail(err), { cause: err });
}

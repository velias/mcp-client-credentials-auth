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

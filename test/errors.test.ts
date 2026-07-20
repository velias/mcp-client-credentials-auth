import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  PROXY_NAME,
  classifyError,
  formatProxyError,
  formatUnrecoverableOAuthMisconfig,
  isPermanentOAuthConfigError,
  isUnrecoverableStartupAuthError,
  toClientError,
  wrapCaughtError,
} from '../src/errors.js';

class FakeInvalidScopeError extends Error {
  readonly errorCode = 'invalid_scope';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScopeError';
  }
}

describe('errors', () => {
  describe('formatProxyError', () => {
    it('uses the consistent category format for all three categories', () => {
      expect(formatProxyError('authentication', 'Invalid scopes: api.graphql')).toBe(
        `${PROXY_NAME} [authentication]: Invalid scopes: api.graphql`,
      );
      expect(formatProxyError('connection', 'temporarily unavailable (reconnecting)')).toBe(
        `${PROXY_NAME} [connection]: temporarily unavailable (reconnecting)`,
      );
      expect(formatProxyError('remote', 'tool failed')).toBe(
        `${PROXY_NAME} [remote]: tool failed`,
      );
    });
  });

  describe('isPermanentOAuthConfigError', () => {
    it('returns true for invalid_scope and invalid_client', () => {
      expect(isPermanentOAuthConfigError(new FakeInvalidScopeError('Invalid scopes: api.graphql'))).toBe(
        true,
      );
      class FakeInvalidClientError extends Error {
        readonly errorCode = 'invalid_client';
      }
      expect(isPermanentOAuthConfigError(new FakeInvalidClientError('bad secret'))).toBe(true);
    });

    it('returns false for transient or unknown errors', () => {
      class FakeServerError extends Error {
        readonly errorCode = 'server_error';
      }
      expect(isPermanentOAuthConfigError(new FakeServerError('IdP busy'))).toBe(false);
      expect(isPermanentOAuthConfigError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isPermanentOAuthConfigError(new UnauthorizedError('Unauthorized'))).toBe(false);
    });
  });

  describe('formatUnrecoverableOAuthMisconfig', () => {
    it('names the IdP when the token request was rejected', () => {
      const message = formatUnrecoverableOAuthMisconfig('Invalid scopes: api.graphql', 'idp');
      expect(message).toContain('at the identity provider (IdP)');
      expect(message).toContain('The IdP rejected the token request (not the MCP server)');
      expect(message).toContain('contact your MCP server provider');
      expect(message).toContain('MCP_CC_PROXY_SCOPES');
    });

    it('names the remote MCP server when the Bearer token was rejected', () => {
      const message = formatUnrecoverableOAuthMisconfig('Unauthorized', 'mcp-server');
      expect(message).toContain('at the remote MCP server');
      expect(message).toContain('The MCP server rejected the access token');
      expect(message).toContain('not an IdP token-request failure');
      expect(message).toContain('contact your MCP server provider');
    });
  });

  describe('isUnrecoverableStartupAuthError', () => {
    it('is true for IdP permanent errors and remote UnauthorizedError', () => {
      expect(
        isUnrecoverableStartupAuthError(new FakeInvalidScopeError('Invalid scopes: api.graphql')),
      ).toBe(true);
      expect(isUnrecoverableStartupAuthError(new UnauthorizedError('Unauthorized'))).toBe(true);
    });

    it('is true for resource-server invalid_token / insufficient_scope', () => {
      class FakeInvalidTokenError extends Error {
        readonly errorCode = 'invalid_token';
      }
      class FakeInsufficientScopeError extends Error {
        readonly errorCode = 'insufficient_scope';
      }
      expect(isUnrecoverableStartupAuthError(new FakeInvalidTokenError('bad token'))).toBe(true);
      expect(isUnrecoverableStartupAuthError(new FakeInsufficientScopeError('need more'))).toBe(
        true,
      );
    });

    it('is false for transient connection failures', () => {
      expect(isUnrecoverableStartupAuthError(new Error('ECONNREFUSED'))).toBe(false);
      class FakeServerError extends Error {
        readonly errorCode = 'server_error';
      }
      expect(isUnrecoverableStartupAuthError(new FakeServerError('IdP busy'))).toBe(false);
    });
  });

  describe('classifyError', () => {
    it('classifies McpError as remote', () => {
      expect(classifyError(new McpError(ErrorCode.InvalidParams, 'bad args'))).toBe('remote');
    });

    it('classifies OAuth errorCode errors as authentication', () => {
      expect(classifyError(new FakeInvalidScopeError('Invalid scopes: api.graphql'))).toBe(
        'authentication',
      );
    });

    it('classifies UnauthorizedError as remote by default (resource server)', () => {
      expect(classifyError(new UnauthorizedError('Unauthorized'))).toBe('remote');
    });

    it('classifies UnauthorizedError as authentication in token context', () => {
      expect(classifyError(new UnauthorizedError('Unauthorized'), 'token')).toBe(
        'authentication',
      );
    });

    it('classifies generic errors as connection', () => {
      expect(classifyError(new Error('ECONNREFUSED'))).toBe('connection');
      expect(classifyError('string error')).toBe('connection');
    });
  });

  describe('toClientError', () => {
    it('builds InternalError with source and category data', () => {
      const err = toClientError('authentication', 'Invalid scopes: api.graphql');
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.message).toContain(`${PROXY_NAME} [authentication]: Invalid scopes: api.graphql`);
      expect(err.data).toEqual({ source: PROXY_NAME, category: 'authentication' });
    });

    it('does not double-prefix already formatted messages', () => {
      const formatted = formatProxyError('connection', 'temporarily unavailable (reconnecting)');
      const err = toClientError('connection', formatted);
      expect(err.message).toContain(formatted);
      expect(err.message.match(/mcp-client-credentials-auth/g)?.length).toBe(1);
    });

    it('preserves remote McpError code and nests original data', () => {
      const remote = new McpError(ErrorCode.InvalidParams, 'missing field', { field: 'x' });
      const err = toClientError('remote', remote.message, { cause: remote });
      expect(err.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain(`${PROXY_NAME} [remote]:`);
      expect(err.message).toContain('missing field');
      expect(err.data).toEqual({
        source: PROXY_NAME,
        category: 'remote',
        remote: { field: 'x' },
      });
    });
  });

  describe('wrapCaughtError', () => {
    it('wraps OAuth scope failures as authentication', () => {
      const err = wrapCaughtError(new FakeInvalidScopeError('Invalid scopes: api.graphql'));
      expect(err.message).toContain('[authentication]');
      expect(err.message).toContain('Invalid scopes: api.graphql');
    });

    it('wraps remote McpError as remote and keeps code', () => {
      const remote = new McpError(ErrorCode.InternalError, 'tool blew up');
      const err = wrapCaughtError(remote);
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.message).toContain('[remote]');
      expect(err.message).toContain('tool blew up');
    });
  });
});

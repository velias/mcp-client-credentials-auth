import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  PROXY_NAME,
  classifyError,
  formatProxyError,
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

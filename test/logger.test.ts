import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn<typeof process.stderr, 'write'>>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('creates a logger with debug disabled by default', () => {
    const logger = createLogger();
    expect(logger.isDebugEnabled).toBe(false);
  });

  it('creates a logger with debug enabled when true is passed', () => {
    const logger = createLogger(true);
    expect(logger.isDebugEnabled).toBe(true);
  });

  describe('log output', () => {
    it('writes info messages to stderr', () => {
      const logger = createLogger();
      logger.info('test message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('level=info');
      expect(output).toContain('component=mcp-client-credentials-auth');
      expect(output).toContain('msg=test message');
      expect(output).toContain('ts=');
      expect(output).toMatch(/\n$/);
    });

    it('writes warn messages to stderr', () => {
      const logger = createLogger();
      logger.warn('warning here');

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('level=warn');
      expect(output).toContain('component=mcp-client-credentials-auth');
      expect(output).toContain('msg=warning here');
    });

    it('writes error messages to stderr', () => {
      const logger = createLogger();
      logger.error('something broke');

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('level=error');
      expect(output).toContain('component=mcp-client-credentials-auth');
      expect(output).toContain('msg=something broke');
    });

    it('includes category metadata on failure logs', () => {
      const logger = createLogger();
      logger.warn('Reconnection failed, will retry', {
        category: 'authentication',
        error: 'Invalid scopes: api.graphql',
      });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('component=mcp-client-credentials-auth');
      expect(output).toContain('category=authentication');
      expect(output).toContain('error=Invalid scopes: api.graphql');
    });

    it('writes debug messages when debug is enabled', () => {
      const logger = createLogger(true);
      logger.debug('debug info');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('level=debug');
      expect(output).toContain('component=mcp-client-credentials-auth');
      expect(output).toContain('msg=debug info');
    });

    it('suppresses debug messages when debug is disabled', () => {
      const logger = createLogger(false);
      logger.debug('should not appear');

      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  describe('metadata formatting', () => {
    it('appends key=value metadata', () => {
      const logger = createLogger();
      logger.info('with meta', { host: 'example.com', port: 443 });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('host=example.com');
      expect(output).toContain('port=443');
    });

    it('does not append metadata section when meta is empty', () => {
      const logger = createLogger();
      logger.info('nometa', {});

      const output = stderrSpy.mock.calls[0][0] as string;
      // Should be: ts=... level=info component=... msg=nometa\n (no trailing key=value pairs)
      expect(output).toMatch(
        /^ts=\S+ level=info component=mcp-client-credentials-auth msg=nometa\n$/,
      );
    });
  });

  describe('secret redaction', () => {
    it('redacts values with secret-like keys', () => {
      const logger = createLogger();
      logger.info('auth', {
        client_secret: 'super-secret',
        access_token: 'tok_abc',
        authorization: 'Bearer xyz',
        token: 'some-token',
        password: 'p4ss',
        secret: 'sshhh',
      });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('super-secret');
      expect(output).not.toContain('tok_abc');
      expect(output).not.toContain('Bearer xyz');
      expect(output).not.toContain('some-token');
      expect(output).not.toContain('p4ss');
      expect(output).not.toContain('sshhh');
      expect(output).toContain('[REDACTED]');
    });

    it('does not redact non-secret keys', () => {
      const logger = createLogger();
      logger.info('safe', { hostname: 'example.com', method: 'GET' });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('hostname=example.com');
      expect(output).toContain('method=GET');
    });

    it('does not redact empty string values even for secret keys', () => {
      const logger = createLogger();
      logger.info('empty', { token: '' });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('[REDACTED]');
    });
  });
});

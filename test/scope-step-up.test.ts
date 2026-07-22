import { describe, it, expect, vi } from 'vitest';
import {
  mergeOAuthScopes,
  parseInsufficientScopeChallenge,
  createScopeStepUpFetch,
} from '../src/scope-step-up.js';
import type { Logger } from '../src/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isDebugEnabled: false,
  };
}

function insufficientScopeResponse(scope: string): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"`,
    },
  });
}

describe('mergeOAuthScopes', () => {
  it('unions and dedupes scopes, keeping current-first order', () => {
    expect(mergeOAuthScopes('read write', 'write email')).toBe('read write email');
  });

  it('handles empty current', () => {
    expect(mergeOAuthScopes(undefined, 'email')).toBe('email');
    expect(mergeOAuthScopes('', 'email')).toBe('email');
  });

  it('accumulates sequential challenges', () => {
    let scopes = 'read';
    scopes = mergeOAuthScopes(scopes, 'email');
    scopes = mergeOAuthScopes(scopes, 'orders.write');
    expect(scopes).toBe('read email orders.write');
  });
});

describe('parseInsufficientScopeChallenge', () => {
  it('returns scope for 403 insufficient_scope', () => {
    expect(parseInsufficientScopeChallenge(insufficientScopeResponse('email profile'))).toBe(
      'email profile',
    );
  });

  it('returns undefined without insufficient_scope or scope', () => {
    expect(
      parseInsufficientScopeChallenge(
        new Response('', {
          status: 403,
          headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseInsufficientScopeChallenge(
        new Response('', {
          status: 403,
          headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' },
        }),
      ),
    ).toBeUndefined();
    expect(parseInsufficientScopeChallenge(new Response('', { status: 401 }))).toBeUndefined();
  });
});

describe('createScopeStepUpFetch', () => {
  it('steps up once and retries with the new Bearer token', async () => {
    const logger = createMockLogger();
    let currentScopes = 'read';
    let accessToken = 'old-token';
    const stepUp = vi.fn(async (challenge: string) => {
      currentScopes = mergeOAuthScopes(currentScopes, challenge);
      accessToken = 'new-token';
    });

    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(insufficientScopeResponse('email'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const wrapped = createScopeStepUpFetch({
      fetch: baseFetch,
      getAccessToken: () => accessToken,
      getCurrentScopes: () => currentScopes,
      stepUp,
      logger,
    });

    const result = await wrapped('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer old-token' },
    });

    expect(result.status).toBe(200);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(stepUp).toHaveBeenCalledWith('email');
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const retryInit = baseFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(retryInit.headers).get('Authorization')).toBe('Bearer new-token');
    expect(logger.warn).toHaveBeenCalledWith(
      'Scope step-up challenge received, acquiring token with updated scopes',
      expect.objectContaining({
        category: 'authentication',
        challengeScopes: 'email',
        mergedScopes: 'read email',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Scope step-up token acquired',
      expect.objectContaining({ scopes: 'read email' }),
    );
  });

  it('does not loop when the retry still returns 403', async () => {
    const logger = createMockLogger();
    const stepUp = vi.fn(async () => {});
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(insufficientScopeResponse('email'))
      .mockResolvedValueOnce(insufficientScopeResponse('email'));

    const wrapped = createScopeStepUpFetch({
      fetch: baseFetch,
      getAccessToken: () => 'new-token',
      getCurrentScopes: () => 'read',
      stepUp,
      logger,
    });

    const result = await wrapped('https://mcp.example.com/mcp', { method: 'POST' });
    expect(result.status).toBe(403);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('passes through unrelated 403 and 401 without step-up', async () => {
    const logger = createMockLogger();
    const stepUp = vi.fn();
    const forbidden = new Response('', {
      status: 403,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
    const unauthorized = new Response('', { status: 401 });
    const baseFetch = vi.fn().mockResolvedValueOnce(forbidden).mockResolvedValueOnce(unauthorized);

    const wrapped = createScopeStepUpFetch({
      fetch: baseFetch,
      getAccessToken: () => 'tok',
      getCurrentScopes: () => 'read',
      stepUp,
      logger,
    });

    expect((await wrapped('https://mcp.example.com/mcp')).status).toBe(403);
    expect((await wrapped('https://mcp.example.com/mcp')).status).toBe(401);
    expect(stepUp).not.toHaveBeenCalled();
  });
});

import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from './logger.js';

/**
 * Work around SDK client_credentials scope step-up bugs (#2255 / #1582):
 * handle 403 insufficient_scope in fetch before the transport's broken upscoping path runs.
 * Remove this module when both upstream issues are fixed in a released SDK (see AGENTS.md).
 */

export function mergeOAuthScopes(current: string | undefined, challenge: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const scope of [...(current ?? '').split(/\s+/), ...challenge.split(/\s+/)]) {
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    merged.push(scope);
  }
  return merged.join(' ');
}

export function parseInsufficientScopeChallenge(response: Response): string | undefined {
  if (response.status !== 403) return undefined;
  const { error, scope } = extractWWWAuthenticateParams(response);
  if (error !== 'insufficient_scope') return undefined;
  if (typeof scope !== 'string' || scope.trim().length === 0) return undefined;
  return scope.trim();
}

export interface ScopeStepUpFetchOptions {
  fetch?: FetchLike;
  getAccessToken: () => string | undefined;
  getCurrentScopes: () => string | undefined;
  /** Merge challenge into current scopes, clear token, acquire a new token. */
  stepUp: (challengeScopes: string) => Promise<void>;
  logger: Logger;
}

function withBearerAuthorization(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

/**
 * Fetch wrapper that intercepts 403 insufficient_scope challenges, acquires a token
 * with merged scopes, and retries the request once with the new Bearer token.
 */
export function createScopeStepUpFetch(options: ScopeStepUpFetchOptions): FetchLike {
  const baseFetch: FetchLike = options.fetch ?? fetch;

  return async (url, init) => {
    const response = await baseFetch(url, init);
    const challengeScopes = parseInsufficientScopeChallenge(response);
    if (!challengeScopes) {
      return response;
    }

    const mergedScopes = mergeOAuthScopes(options.getCurrentScopes(), challengeScopes);
    options.logger.warn('Scope step-up challenge received, acquiring token with updated scopes', {
      category: 'authentication',
      challengeScopes,
      mergedScopes,
    });

    try {
      await options.stepUp(challengeScopes);
    } catch (err) {
      options.logger.warn('Scope step-up token acquisition failed', {
        category: 'authentication',
        challengeScopes,
        mergedScopes,
        error: err instanceof Error ? err.message : String(err),
      });
      return response;
    }

    const accessToken = options.getAccessToken();
    if (!accessToken) {
      options.logger.warn('Scope step-up produced no access token, returning original 403', {
        category: 'authentication',
        mergedScopes,
      });
      return response;
    }

    options.logger.info('Scope step-up token acquired', {
      category: 'authentication',
      scopes: mergedScopes,
    });

    // Single retry only — do not recurse into another step-up on this call.
    return baseFetch(url, withBearerAuthorization(init, accessToken));
  };
}

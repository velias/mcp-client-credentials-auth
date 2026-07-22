/** Exponential backoff with jitter for auth and connection retries. */

export function getBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

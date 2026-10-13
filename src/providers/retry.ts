import { ProviderError } from './errors.js';

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  /** Retry-After values above this are not waited for; the error is surfaced instead. */
  maxDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError({ provider: '', code: 'cancelled', message: 'Request cancelled.' }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError({ provider: '', code: 'cancelled', message: 'Request cancelled.' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function makeRetryPolicy(
  maxRetries: number,
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return { maxRetries, baseDelayMs: 1000, maxDelayMs: 30_000, sleep: defaultSleep, ...overrides };
}

function delayFor(policy: RetryPolicy, attempt: number, error: ProviderError): number | undefined {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs > policy.maxDelayMs ? undefined : error.retryAfterMs;
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exponential * (1 + Math.random() * 0.25));
}

function shouldRetry(policy: RetryPolicy, attempt: number, error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable && attempt < policy.maxRetries;
}

/** Retries a request/response call on retryable provider errors. */
export async function withRetry<T>(
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!shouldRetry(policy, attempt, error)) throw error;
      const delayMs = delayFor(policy, attempt, error);
      if (delayMs === undefined) throw error;
      policy.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await policy.sleep(delayMs, signal);
    }
  }
}

/**
 * Retries a streaming call, but only while nothing has been yielded yet.
 * Once output has reached the caller a retry would duplicate or corrupt it, so the error is thrown.
 */
export async function* streamWithRetry<T>(
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  attemptFn: (attempt: number) => AsyncIterable<T>,
): AsyncGenerator<T> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const item of attemptFn(attempt)) {
        yielded = true;
        yield item;
      }
      return;
    } catch (error) {
      if (yielded || !shouldRetry(policy, attempt, error)) throw error;
      const delayMs = delayFor(policy, attempt, error);
      if (delayMs === undefined) throw error;
      policy.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await policy.sleep(delayMs, signal);
    }
  }
}

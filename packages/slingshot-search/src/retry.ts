/**
 * Retry with exponential backoff for search provider operations.
 *
 * Transient failures (timeouts, connection resets, 5xx, 429) are retried
 * automatically. Circuit-open errors and non-transient errors propagate
 * immediately so the circuit breaker can maintain accurate state.
 */
import { SearchCircuitOpenError } from './searchCircuitBreaker';

/** Configuration for the exponential-backoff retry loop. */
export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default 2. */
  readonly maxRetries: number;
  /** Base delay in ms for the exponential backoff. Default 100. */
  readonly baseDelayMs: number;
  /** Maximum delay cap in ms. Default 2_000. */
  readonly maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
};

/**
 * Returns `true` when the error represents a transient condition that should
 * be retried.
 *
 * Circuit-open errors (`SearchCircuitOpenError`) are excluded — the breaker
 * handles those separately. Timeout, connection-refused, DNS, and
 * server-error (5xx / 429) responses are treated as retriable.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof SearchCircuitOpenError) return false;
  if (err instanceof Error) {
    const msg = err.message;
    const lower = msg.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out')) return true;
    if (lower.includes('econnrefused') || lower.includes('connection refused')) return true;
    if (lower.includes('econnreset') || lower.includes('socket hang up')) return true;
    if (lower.includes('etimedout') || lower.includes('eai_again')) return true;
    if (lower.includes('enotfound') || lower.includes('enxio')) return true;
    if (
      lower.includes('429') ||
      lower.includes('503') ||
      lower.includes('502') ||
      lower.includes('504')
    )
      return true;
    if (lower.includes('service unavailable') || lower.includes('too many requests')) return true;
  }
  return false;
}

/**
 * Invoke `fn` with retries and exponential backoff.
 *
 * Only transient errors (as defined by `isTransientError`) trigger a retry.
 * Non-transient errors and circuit-open errors propagate immediately.
 *
 * @param fn - The operation to retry.
 * @param options - Optional retry configuration overrides.
 * @returns The result of `fn` on success.
 * @throws The last error encountered after exhausting all retries, or the
 *   first non-transient error.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => provider.search('my_index', query),
 *   { maxRetries: 3, baseDelayMs: 200 },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < opts.maxRetries && isTransientError(err)) {
        const delay = Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }

  // Should not reach here because the loop always returns or throws,
  // but keep the fallthrough for compiler safety.
  throw lastError ?? new Error('[slingshot-search] Retry exhausted');
}

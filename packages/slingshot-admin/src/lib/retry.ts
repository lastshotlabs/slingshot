/**
 * Retry-with-backoff helper for transient provider failures.
 *
 * Uses exponential backoff with full jitter so retries do not thash the
 * upstream. Only retries errors that match the `shouldRetry` predicate
 * (by default, all errors are retried up to `maxRetries` times).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for `withRetry`. */
export interface RetryOptions {
  /** Maximum number of retry attempts (excluding the initial call). Default 3. */
  readonly maxRetries?: number;
  /** Base delay before the first retry, in ms. Default 200. */
  readonly baseDelayMs?: number;
  /** Maximum delay between retries, in ms. Default 5_000. */
  readonly maxDelayMs?: number;
  /**
   * Predicate that determines whether a given error is retryable.
   * Defaults to retrying all errors. When the predicate returns `false`
   * the error is re-thrown immediately without further retries.
   */
  readonly shouldRetry?: (error: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute the retry delay for attempt `attempt` (0-based) using exponential
 * backoff with full jitter.
 *
 *   sleep = min(cap, random(0, 2^attempt * base))
 *
 * Full jitter spreads retry times uniformly over the interval, preventing
 * retry-storms when many callers fail simultaneously.
 */
function computeDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.pow(2, attempt) * baseDelayMs;
  const capped = Math.min(exponential, maxDelayMs);
  return Math.random() * capped;
}

/**
 * Invoke `fn` with retries on failure.
 *
 * The function is called immediately. If it rejects and the error passes
 * `shouldRetry`, up to `maxRetries` additional attempts are made with
 * exponential backoff. Non-retryable errors and errors that persist after
 * all retries are exhausted are thrown to the caller.
 *
 * @param fn - The async function to invoke (possibly multiple times).
 * @param opts - Retry configuration.
 * @returns The resolved value of `fn`.
 * @throws The last error encountered if all retries are exhausted.
 *
 * @example
 * ```ts
 * const result = await withRetry(() => fetch('https://api.example.com'), {
 *   maxRetries: 3,
 *   shouldRetry: (err) => err instanceof TypeError, // network errors only
 * });
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && shouldRetry(err)) {
        const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }

  // This line should never be reached (the final retry throws), but TypeScript
  // cannot prove it from the control flow above.
  throw lastError;
}

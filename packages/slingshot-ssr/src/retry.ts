/**
 * Retry logic for page load failures in slingshot-ssr.
 *
 * Provides a generic `retry()` function with exponential backoff and jitter.
 * Used by the SSR middleware to retry renderer calls when they fail with
 * retryable errors (network timeouts, 5xx responses from upstream APIs).
 *
 * Non-retryable errors (e.g. validation errors, authentication failures) are
 * re-thrown immediately without retrying.
 */

/**
 * Options for {@link retry}.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts (excluding the initial call).
   * @default 2
   */
  maxAttempts: number;
  /**
   * Base delay in milliseconds for the first retry. Subsequent retries use
   * exponential backoff: `baseDelayMs * 2^(attempt-1)`.
   * @default 200
   */
  baseDelayMs: number;
  /**
   * Optional predicate to determine whether a specific error is retryable.
   * When omitted, all errors are considered retryable (subject to maxAttempts).
   */
  isRetryable?: (error: Error) => boolean;
  /**
   * Optional callback invoked before each retry attempt. Receives the error
   * that caused the retry and the attempt number (1-based).
   */
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Default retry configuration.
 */
const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 2,
  baseDelayMs: 200,
  isRetryable: () => true,
  onRetry: () => {},
};

/**
 * Execute `fn` with retry on failure.
 *
 * Implements exponential backoff with full jitter between retries. The initial
 * call counts as attempt 1; subsequent retries use the formula:
 * ```
 * delay = random(0, baseDelayMs * 2^(attempt-1))
 * ```
 *
 * @param fn - The async function to execute with retry support.
 * @param options - Retry configuration.
 * @returns The return value of `fn` on success.
 * @throws The last error encountered if all attempts fail.
 *
 * @example
 * ```ts
 * const html = await retry(
 *   () => renderPage(url, config),
 *   { maxAttempts: 3, baseDelayMs: 500, isRetryable: (e) => e.message.includes('timeout') },
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, isRetryable, onRetry } = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      if (attempt <= maxAttempts && isRetryable(error)) {
        const delay = Math.random() * baseDelayMs * Math.pow(2, attempt - 1);
        onRetry(error, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Last attempt or non-retryable error — re-throw
        throw error;
      }
    }
  }

  // Should never reach here, but TypeScript needs a return.
  throw lastError ?? new Error('Retry exhausted without a result');
}

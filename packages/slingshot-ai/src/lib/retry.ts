/**
 * Retry policy.
 *
 * Exactly one layer, on top of whatever the provider SDK already does. We retry
 * only what the adapter classified as retryable, and we honor an explicit
 * `retryAfterMs` when the provider gave us one.
 *
 * The important constraint is enforced by the CALLER, not here: every retry —
 * and every structured-repair attempt — must re-enter the spend guard. A repair
 * loop against a stubborn local model is exactly the shape of an accidental
 * bill, and "we already checked the budget once" is how you get one.
 */
import { AiProviderError, AiRateLimitError } from '../errors';
import type { AiLogger } from '../provider/types';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly logger?: AiLogger;
  readonly onAttempt?: (attempt: number) => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function backoffMs(attempt: number, base: number, max: number): number {
  const exponential = Math.min(max, base * 2 ** (attempt - 1));
  // Full jitter — the point is to spread a thundering herd, not to be precise.
  return Math.round(Math.random() * exponential);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AiRateLimitError) return true;
  if (error instanceof AiProviderError) return error.retryable;
  return false;
}

/**
 * Run `fn`, retrying retryable failures.
 *
 * `onAttempt` fires before EVERY attempt including the first — that is the hook
 * the orchestrator uses to re-check the spend guard.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await options.onAttempt?.(attempt);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts) throw error;

      const explicit = error instanceof AiRateLimitError ? error.retryAfterMs : null;
      const delay = explicit ?? backoffMs(attempt, base, max);
      options.logger?.debug(
        `retrying after a retryable provider error (attempt ${attempt}/${maxAttempts})`,
        { delayMs: delay, attempt },
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

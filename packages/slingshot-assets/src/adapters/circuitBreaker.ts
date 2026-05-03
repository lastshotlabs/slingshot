/**
 * Shared circuit breaker for storage adapters.
 *
 * State machine:
 *   closed    — normal operation; failures increment a counter
 *   open      — fail fast; reject every request until cooldown elapses
 *   half-open — let exactly one probe through; success resets, failure re-opens
 *
 * Each guarded operation, after exhausting its own retries, counts as a single
 * breaker failure so a transient blip that recovers inside the retry budget
 * does not trip the breaker.
 */

/** Snapshot of the circuit breaker state. */
export interface CircuitBreakerState {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/** Circuit breaker that guards async operations. */
export interface CircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `CircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>, op: string): Promise<T>;
  /** Snapshot the current breaker state. */
  getState(): CircuitBreakerState;
}

/**
 * Construct a circuit breaker.
 */
export function createCircuitBreaker(opts: {
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly now: () => number;
}): CircuitBreaker {
  const { threshold, cooldownMs, now } = opts;

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getState(): CircuitBreakerState {
    const nextProbeAt =
      state === 'open' && openedAt !== undefined ? openedAt + cooldownMs : undefined;
    return { state, consecutiveFailures, openedAt, nextProbeAt };
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    state = 'closed';
    openedAt = undefined;
    halfOpenInFlight = false;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (state === 'half-open') {
      // Probe failed — reopen and back off again.
      state = 'open';
      openedAt = now();
      halfOpenInFlight = false;
      return;
    }
    if (consecutiveFailures >= threshold && state === 'closed') {
      state = 'open';
      openedAt = now();
    }
  }

  function tryEnterHalfOpen(): boolean {
    if (state !== 'open') return true;
    if (openedAt === undefined) return true;
    if (now() - openedAt < cooldownMs) return false;
    if (halfOpenInFlight) return false;
    state = 'half-open';
    halfOpenInFlight = true;
    return true;
  }

  async function guard<T>(fn: () => Promise<T>, op: string): Promise<T> {
    if (!tryEnterHalfOpen()) {
      const retryAfterMs = openedAt !== undefined ? Math.max(0, openedAt + cooldownMs - now()) : 0;
      throw new CircuitOpenError(
        `[slingshot-assets] Circuit breaker open after ${consecutiveFailures} ` +
          `consecutive failures. Retrying in ~${retryAfterMs}ms. Operation: ${op}`,
        retryAfterMs,
      );
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  return { guard, getState };
}

/**
 * Error thrown when a circuit breaker is open and short-circuits a request.
 */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Retry a potentially-failing async operation with exponential back-off.
 *
 * Attempts `fn` up to `attempts` times. On each failure (except the last),
 * waits `baseDelayMs × 2^attempt` milliseconds before the next try. The final
 * failure is rethrown to the caller.
 *
 * @param fn - The async operation to run.
 * @param attempts - Maximum number of tries.
 * @param baseDelayMs - Base delay in milliseconds. Actual wait = `baseDelayMs × 2^attempt`.
 * @param isRetryable - Optional predicate to filter retryable errors. When
 *   provided, non-retryable errors are rethrown immediately without further
 *   attempts. When omitted, all errors are retried.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  isRetryable?: (err: unknown) => boolean,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      if (isRetryable && !isRetryable(err)) throw err;
      // Exponential backoff: baseDelay × 2^i
      await new Promise<void>(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
  // unreachable — loop always throws or returns before here
  throw new Error('[withRetry] unreachable');
}

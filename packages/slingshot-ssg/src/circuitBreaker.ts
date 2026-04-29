/**
 * Consecutive-failure circuit breaker for SSG render operations.
 *
 * Mirrors the pattern from `slingshot-mail`'s circuit breaker so operational
 * behaviour stays uniform across production-track packages. Guards external
 * HTTP fetches during SSG rendering to fail fast during sustained upstream
 * outages rather than let the build thrash against a degraded service.
 */

/**
 * Thrown when the breaker is open and refuses to issue a render attempt.
 *
 * `retryAfterMs` is the time remaining until the breaker transitions to
 * half-open state. Callers can surface this as a backoff hint.
 */
export class SsgCircuitOpenError extends Error {
  readonly code = 'SSG_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `[slingshot-ssg] Circuit breaker open. Retrying in ~${retryAfterMs}ms.`,
    );
    this.name = 'SsgCircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Snapshot of breaker state — useful for health probes and test assertions. */
export interface SsgCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/**
 * Circuit breaker guarding external HTTP calls during SSG rendering.
 */
export interface SsgCircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `SsgCircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  getHealth(): SsgCircuitBreakerHealth;
}

/** Tunable options for constructing an SSG circuit breaker. */
export interface SsgCircuitBreakerOptions {
  /** Consecutive failure count required to trip the breaker. Default 5. */
  readonly threshold?: number;
  /** Cooldown before a half-open probe is admitted, in ms. Default 30_000. */
  readonly cooldownMs?: number;
  /** Override the time source — useful for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Construct an SSG circuit breaker.
 *
 * State machine:
 *   closed    — normal operation; failures increment a counter.
 *   open      — fail fast; reject every request until cooldown elapses.
 *   half-open — let exactly one probe through; success resets, failure
 *               re-opens.
 */
export function createSsgCircuitBreaker(
  opts: SsgCircuitBreakerOptions = {},
): SsgCircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getHealth(): SsgCircuitBreakerHealth {
    const nextProbeAt =
      state === 'open' && openedAt !== undefined
        ? openedAt + cooldownMs
        : undefined;
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

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    if (!tryEnterHalfOpen()) {
      const retryAfterMs =
        openedAt !== undefined
          ? Math.max(0, openedAt + cooldownMs - now())
          : 0;
      throw new SsgCircuitOpenError(retryAfterMs);
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

  return { guard, getHealth };
}

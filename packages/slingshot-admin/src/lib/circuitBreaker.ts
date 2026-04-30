/**
 * Consecutive-failure circuit breaker for admin provider calls.
 *
 * Guards outbound calls to external admin providers (Auth0, audit-log backends,
 * etc.) so the plugin fails fast during sustained provider outages rather than
 * letting request handlers thrash against a degraded upstream.
 *
 * Mirrors the shape of `slingshot-mail`'s circuit breaker so operational
 * behaviour stays uniform across production-track packages.
 */
// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when the breaker is open and refuses to invoke the provider.
 *
 * `retryAfterMs` is the time remaining until the breaker enters half-open
 * state. Callers can surface this as a backoff hint.
 */
export class AdminCircuitOpenError extends Error {
  readonly code = 'ADMIN_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  readonly providerName: string;

  constructor(message: string, providerName: string, retryAfterMs: number) {
    super(message);
    this.name = 'AdminCircuitOpenError';
    this.providerName = providerName;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of breaker state -- useful for health endpoints and metrics. */
export interface AdminCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/** Runtime circuit breaker guarding admin provider calls. */
export interface AdminCircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `AdminCircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  /** Snapshot of current breaker state. */
  getHealth(): AdminCircuitBreakerHealth;
}

/** Tunable options used to construct a circuit breaker. */
export interface AdminCircuitBreakerOptions {
  /** Consecutive failure count required to trip the breaker. Default 5. */
  readonly threshold?: number;
  /** Cooldown before a half-open probe is admitted, in ms. Default 30_000. */
  readonly cooldownMs?: number;
  /** Provider name surfaced in `AdminCircuitOpenError`. */
  readonly providerName: string;
  /** Override the time source -- useful for deterministic tests. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a circuit breaker for admin provider calls.
 *
 * State machine:
 *   closed    -- normal operation; failures increment a counter.
 *   open      -- fail fast; reject every request until cooldown elapses.
 *   half-open -- let exactly one probe through; success resets, failure
 *                re-opens.
 *
 * @param opts - Configuration options.
 * @returns An `AdminCircuitBreaker` instance.
 */
export function createAdminCircuitBreaker(opts: AdminCircuitBreakerOptions): AdminCircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const providerName = opts.providerName;

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getHealth(): AdminCircuitBreakerHealth {
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
    if (state !== 'open') {
      // In half-open state, reject when a probe is already in flight so
      // only one request at a time is allowed through. When closed, let
      // everything through.
      if (state === 'half-open' && halfOpenInFlight) return false;
      return true;
    }
    if (openedAt === undefined) return true;
    if (now() - openedAt < cooldownMs) return false;
    if (halfOpenInFlight) return false;
    state = 'half-open';
    halfOpenInFlight = true;
    return true;
  }

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    if (!tryEnterHalfOpen()) {
      const retryAfterMs = openedAt !== undefined ? Math.max(0, openedAt + cooldownMs - now()) : 0;
      throw new AdminCircuitOpenError(
        `[slingshot-admin:${providerName}] Circuit breaker open after ` +
          `${consecutiveFailures} consecutive failures. ` +
          `Retrying in ~${retryAfterMs}ms.`,
        providerName,
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

  return { guard, getHealth };
}

/**
 * Circuit breaker for search provider calls at the search-manager level.
 *
 * Provides manager-level fail-fast behavior when a search provider is
 * unreachable, independent of any provider-level breakers. Mirrors the
 * pattern from `slingshot-mail` and `slingshot-assets` so operational
 * behaviour stays uniform across production-track packages.
 *
 * State machine:
 *   closed    — normal operation; failures increment a counter.
 *   open      — fail fast; reject every request until cooldown elapses.
 *   half-open — let exactly one probe through; success resets, failure re-opens.
 */

/**
 * Thrown when the breaker is open and refuses to invoke the provider.
 *
 * `retryAfterMs` is the time remaining until the breaker enters half-open
 * state. Workers can surface this as a backoff hint instead of treating the
 * rejection as a generic transient failure.
 */
export class SearchCircuitOpenError extends Error {
  readonly code = 'SEARCH_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  readonly providerKey: string;
  constructor(message: string, providerKey: string, retryAfterMs: number) {
    super(message);
    this.name = 'SearchCircuitOpenError';
    this.providerKey = providerKey;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Snapshot of breaker state — useful for health endpoints and metrics. */
export interface SearchCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/** Runtime circuit breaker guarding search provider calls at the manager level. */
export interface SearchCircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `SearchCircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  /** Read-only health snapshot. Safe to call from a health endpoint. */
  getHealth(): SearchCircuitBreakerHealth;
  /** Reset the breaker to closed state (used during teardown or after recovery). */
  reset(): void;
}

/** Tunable options used to construct a search manager-level circuit breaker. */
export interface SearchCircuitBreakerOptions {
  /** Consecutive failure count required to trip the breaker. Default 5. */
  readonly threshold?: number;
  /** Cooldown before a half-open probe is admitted, in ms. Default 30_000 (30 s). */
  readonly cooldownMs?: number;
  /** Provider key surfaced in `SearchCircuitOpenError`. */
  readonly providerKey: string;
  /** Override the time source — useful for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Construct a search manager-level circuit breaker.
 *
 * Tracks consecutive failures per configured provider. When the threshold is
 * reached the breaker opens, causing all calls to that provider to fail fast
 * with `SearchCircuitOpenError`. After `cooldownMs` a single half-open probe
 * is admitted; success resets the breaker, failure re-opens it with a fresh
 * cooldown.
 */
export function createSearchCircuitBreaker(
  opts: SearchCircuitBreakerOptions,
): SearchCircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const providerKey = opts.providerKey;

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getHealth(): SearchCircuitBreakerHealth {
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
    if (state === 'closed') return true;
    // When half-open, only admit calls while no probe is in flight.
    if (state === 'half-open') return !halfOpenInFlight;
    // state === 'open'
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
      throw new SearchCircuitOpenError(
        `[slingshot-search:${providerKey}] Circuit breaker open after ` +
          `${consecutiveFailures} consecutive failures. Retrying in ` +
          `~${retryAfterMs}ms.`,
        providerKey,
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

  function reset(): void {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = undefined;
    halfOpenInFlight = false;
  }

  return { guard, getHealth, reset };
}

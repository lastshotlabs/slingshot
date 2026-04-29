/**
 * Circuit breaker for external rendering dependencies in slingshot-ssr.
 *
 * The circuit breaker protects the SSR render pipeline from cascading failures
 * when external rendering dependencies (e.g. the renderer's own page rendering,
 * external API calls from loaders) become degraded or unavailable.
 *
 * ## States
 * - **CLOSED** (normal): requests pass through. Failures are counted.
 * - **OPEN** (degraded): requests are rejected immediately without calling the
 *   protected function. A cooldown timer starts.
 * - **HALF_OPEN** (probing): after the cooldown, one probe request is allowed.
 *   If it succeeds, the circuit closes. If it fails, the circuit re-opens.
 *
 * This module provides both a generic `CircuitBreaker` interface and a
 * concrete `createCircuitBreaker()` factory with sensible defaults for SSR.
 */

/**
 * Circuit breaker state machine states.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Result returned by {@link CircuitBreaker.execute}.
 */
export type CircuitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error; reason: 'circuit_open' | 'execution_failed' };

/**
 * Options for {@link createCircuitBreaker}.
 */
export interface CircuitBreakerOptions {
  /**
   * Maximum number of consecutive failures before the circuit opens.
   * @default 5
   */
  failureThreshold: number;
  /**
   * Milliseconds to wait before transitioning from OPEN to HALF_OPEN.
   * @default 30_000 (30 seconds)
   */
  cooldownMs: number;
  /**
   * Optional function called on state transitions for observability.
   */
  onStateChange?: (from: CircuitState, to: CircuitState, reason: string) => void;
  /**
   * Optional function called when a failure is recorded.
   */
  onFailure?: (error: Error, failures: number) => void;
}

/**
 * Circuit breaker contract.
 *
 * Implementations wrap an external dependency call with failure counting,
 * automatic circuit opening, and recovery probing.
 *
 * @example
 * ```ts
 * const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
 * const result = await breaker.execute(() => riskyExternalCall());
 * if (!result.ok) {
 *   // handle gracefully
 * }
 * ```
 */
export interface CircuitBreaker {
  /**
   * Execute `fn` through the circuit breaker.
   *
   * - When the circuit is CLOSED: `fn` is called; failures increment the counter.
   * - When the circuit is OPEN: `fn` is NOT called; returns an error immediately.
   * - When the circuit is HALF_OPEN: one probe call is allowed; success closes,
   *   failure re-opens.
   */
  execute<T>(fn: () => Promise<T>): Promise<CircuitResult<T>>;

  /**
   * Force the circuit into the OPEN state. Useful for manual reset or
   * health-check initiated degradation.
   */
  open(reason?: string): void;

  /**
   * Force the circuit into the CLOSED state and reset the failure count.
   */
  close(): void;

  /**
   * Current state of the circuit.
   */
  readonly state: CircuitState;

  /**
   * Current consecutive failure count.
   */
  readonly failureCount: number;

  /**
   * Reset the circuit to its initial state (closed, zero failures).
   */
  reset(): void;
}

/**
 * Default options used when values are omitted.
 */
const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  onStateChange: () => {},
  onFailure: () => {},
};

/**
 * Create a circuit breaker wrapping an external dependency.
 *
 * @param options - Circuit breaker configuration. Falls back to defaults when omitted.
 * @returns A `CircuitBreaker` instance.
 *
 * @example
 * ```ts
 * const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
 * const result = await cb.execute(() => renderer.renderChain(chain, shell, bsCtx));
 * if (!result.ok) {
 *   return c.html(fallbackHtml, 503);
 * }
 * ```
 */
export function createCircuitBreaker(options: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  const { failureThreshold, cooldownMs, onStateChange, onFailure } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let state: CircuitState = 'closed';
  let failureCount = 0;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFailureTime = 0;

  function setState(newState: CircuitState, reason: string): void {
    if (state !== newState) {
      const prev = state;
      state = newState;
      onStateChange(prev, newState, reason);
    }
  }

  return {
    get state() {
      // Auto-transition from OPEN to HALF_OPEN when the cooldown has expired.
      if (state === 'open' && Date.now() - lastFailureTime >= cooldownMs) {
        setState('half_open', 'cooldown expired');
      }
      return state;
    },

    get failureCount() {
      return failureCount;
    },

    open(reason?: string) {
      lastFailureTime = Date.now();
      setState('open', reason ?? 'manual open');
    },

    close() {
      failureCount = 0;
      setState('closed', 'manual close');
    },

    reset() {
      if (cooldownTimer) {
        clearTimeout(cooldownTimer);
        cooldownTimer = undefined;
      }
      failureCount = 0;
      lastFailureTime = 0;
      state = 'closed';
    },

    async execute<T>(fn: () => Promise<T>): Promise<CircuitResult<T>> {
      // Check if we should auto-transition based on cooldown
      const currentState = this.state;

      if (currentState === 'open') {
        return { ok: false, error: new Error('Circuit breaker is OPEN'), reason: 'circuit_open' };
      }

      // HALF_OPEN — allow one probe
      // CLOSED — normal operation
      try {
        const value = await fn();
        // Success — close the circuit if it was half-open, or reset failures
        if (currentState === 'half_open') {
          failureCount = 0;
          setState('closed', 'probe succeeded');
        } else {
          // Reset failure count on success in closed state (not strictly necessary
          // since we only check the threshold, but keeps the count accurate).
          failureCount = 0;
        }
        return { ok: true, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        failureCount += 1;
        lastFailureTime = Date.now();
        onFailure(error, failureCount);

        if (currentState !== 'half_open' && failureCount >= failureThreshold) {
          setState('open', `failure threshold reached (${failureCount})`);
        } else if (currentState === 'half_open') {
          // Probe failed — back to open
          setState('open', 'probe failed');
        }

        return { ok: false, error, reason: 'execution_failed' };
      }
    },
  };
}

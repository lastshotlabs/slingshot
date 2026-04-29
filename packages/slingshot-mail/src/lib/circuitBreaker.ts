/**
 * Consecutive-failure circuit breaker for outbound mail provider calls.
 *
 * Mirrors the shape of `slingshot-search`'s typesense breaker and the
 * `slingshot-assets` S3 breaker so operational behaviour stays uniform across
 * production-track packages. The intent is to fail fast during sustained
 * provider outages rather than let queue workers thrash against a degraded
 * upstream.
 */

/**
 * Thrown when the breaker is open and refuses to invoke the provider.
 *
 * `retryAfterMs` is the time remaining until the breaker enters half-open
 * state. Workers can surface this as a backoff hint instead of treating the
 * rejection as a generic transient failure.
 */
export class MailCircuitOpenError extends Error {
  readonly code = 'MAIL_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  readonly providerName: string;
  constructor(message: string, providerName: string, retryAfterMs: number) {
    super(message);
    this.name = 'MailCircuitOpenError';
    this.providerName = providerName;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Snapshot of breaker state — useful for health endpoints and metrics. */
export interface MailCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/**
 * Runtime circuit breaker guarding outbound mail provider calls.
 */
export interface MailCircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `MailCircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  getHealth(): MailCircuitBreakerHealth;
}

/**
 * Tunable options used to construct a mail provider circuit breaker.
 */
export interface MailCircuitBreakerOptions {
  /** Consecutive failure count required to trip the breaker. Default 5. */
  readonly threshold?: number;
  /** Cooldown before a half-open probe is admitted, in ms. Default 30_000. */
  readonly cooldownMs?: number;
  /** Provider name surfaced in `MailCircuitOpenError`. */
  readonly providerName: string;
  /** Override the time source — useful for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Construct a mail provider circuit breaker.
 *
 * State machine:
 *   closed    — normal operation; failures increment a counter.
 *   open      — fail fast; reject every request until cooldown elapses.
 *   half-open — let exactly one probe through; success resets, failure re-opens.
 */
export function createMailCircuitBreaker(opts: MailCircuitBreakerOptions): MailCircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const providerName = opts.providerName;

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getHealth(): MailCircuitBreakerHealth {
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
      const retryAfterMs = openedAt !== undefined ? Math.max(0, openedAt + cooldownMs - now()) : 0;
      throw new MailCircuitOpenError(
        `[slingshot-mail:${providerName}] Circuit breaker open after ${consecutiveFailures} ` +
          `consecutive failures. Retrying in ~${retryAfterMs}ms.`,
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

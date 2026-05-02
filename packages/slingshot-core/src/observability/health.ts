/**
 * Component health contract for prod-track packages.
 *
 * Components (event bus adapters, queues, search clients, mailers, etc.)
 * implement {@link HealthCheck} so the framework can aggregate per-component
 * state into a single readiness/liveness response without each package
 * inventing its own shape.
 *
 * `getHealth()` is synchronous and returns the last cached state — cheap
 * enough to call from a `/health` request handler. `checkHealth()` is the
 * optional active probe that may perform I/O against the underlying system.
 */

/**
 * Coarse health categorisation reported by a component.
 *
 * - `healthy` — fully operational.
 * - `degraded` — operating with reduced capability (e.g. fallback adapter,
 *   elevated lag, partial connectivity). Traffic may continue.
 * - `unhealthy` — not serving its contract; callers should fail over or fail
 *   fast.
 */
export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Per-component health snapshot. Aggregators combine many of these into a
 * single response.
 */
export interface HealthReport {
  /** Coarse state suitable for readiness gates. */
  state: HealthState;
  /** Human-readable reason. Optional but encouraged for non-healthy reports. */
  message?: string;
  /** Component-specific facts: queue depth, lag, connected count, etc. */
  details?: Record<string, unknown>;
  /** Stable component name used as the aggregation key. */
  component: string;
}

/**
 * Implemented by any component that wants to participate in framework-level
 * health aggregation.
 */
export interface HealthCheck {
  /** Synchronously return the last-cached state. Cheap. */
  getHealth(): HealthReport;
  /** Optionally run an active probe. May connect to external systems. */
  checkHealth?(): Promise<HealthReport>;
}

// ============================================================================
// User-facing health indicators
// ============================================================================

/**
 * Severity of a failed health indicator.
 *
 * - `critical` — a failure flips `/health/ready` to 503 (the load balancer
 *   should pull the instance out of rotation).
 * - `warning` — a failure marks the response `'degraded'` but keeps the 200
 *   status, so the instance stays in rotation while operators investigate.
 */
export type HealthIndicatorSeverity = 'critical' | 'warning';

/**
 * Result returned from a health indicator's `check()` function.
 *
 * Return `{ status: 'ok' }` when the dependency is responding normally; return
 * `'degraded'` for "responding but slow / partial"; return `'unhealthy'` (or
 * throw) for "down". Any thrown error is treated as `unhealthy` with the error
 * message captured in `message`.
 */
export interface HealthIndicatorResult {
  /** Coarse state for this indicator. */
  readonly status: HealthState;
  /** Human-readable reason. Surfaced verbatim in the `/health/ready` response. */
  readonly message?: string;
  /** Indicator-specific facts (e.g. latency, queue depth, version). */
  readonly details?: Record<string, unknown>;
}

/**
 * Context passed to a health indicator's `check()` function.
 *
 * `ctx` is the live Slingshot context — use it to reach databases, caches,
 * queues, or any plugin state needed by the probe.
 */
export interface HealthIndicatorContext {
  readonly ctx: import('../context/index').SlingshotContext;
}

/**
 * A user-defined readiness probe. Registered via `defineApp({ health: {
 * indicators: [...] } })` and run by the `/health/ready` route on every
 * request.
 *
 * @example
 * ```ts
 * import { defineHealthIndicator } from '@lastshotlabs/slingshot';
 *
 * const postgresHealth = defineHealthIndicator({
 *   name: 'postgres',
 *   severity: 'critical',
 *   check: async ({ ctx }) => {
 *     const start = Date.now();
 *     await ctx.persistence.postgres.ping();
 *     return { status: 'healthy', details: { latencyMs: Date.now() - start } };
 *   },
 * });
 * ```
 */
export interface HealthIndicator {
  /**
   * Unique stable name. Used as the response key in `/health/ready`.
   * Convention: lowercase, hyphenated (e.g. `'postgres'`, `'redis'`,
   * `'stripe-api'`).
   */
  readonly name: string;
  /**
   * Failure severity. Defaults to `'critical'` — a failed indicator flips the
   * readiness status to 503 so the load balancer pulls the instance.
   */
  readonly severity?: HealthIndicatorSeverity;
  /**
   * The probe itself. Should complete in tens of milliseconds; the framework
   * applies a 5-second hard timeout per indicator and treats timeouts as
   * `unhealthy`.
   */
  readonly check: (context: HealthIndicatorContext) => Promise<HealthIndicatorResult>;
}

/**
 * Declare a health indicator. This is a typed identity helper — it doesn't
 * register anything by itself; the indicator must be passed to
 * `defineApp({ health: { indicators: [...] } })` to take effect.
 *
 * Returns the input frozen and unchanged so callers can pass it through any
 * config pipeline.
 */
export function defineHealthIndicator(indicator: HealthIndicator): HealthIndicator {
  return Object.freeze({
    severity: 'critical' as const,
    ...indicator,
  });
}

/**
 * App-level health config — declared on `defineApp({ health: { ... } })`.
 */
export interface HealthAppConfig {
  /** User-defined readiness probes run by `/health/ready`. */
  readonly indicators?: readonly HealthIndicator[];
}

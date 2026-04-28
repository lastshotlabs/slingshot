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

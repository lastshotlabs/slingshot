import type { MiddlewareHandler } from 'hono';
import type { AppEnv, MetricsEmitter } from '@lastshotlabs/slingshot-core';

export interface MetricsConfig {
  /** Enable the /metrics endpoint. Default: false (must be explicitly enabled). */
  enabled?: boolean;
  /**
   * Auth protection for the /metrics endpoint.
   * - `"userAuth"` — requires authenticated user session.
   * - `"none"` — no auth (default — logs a production warning).
   * - `MiddlewareHandler[]` — custom middleware stack.
   */
  auth?: 'userAuth' | 'none' | MiddlewareHandler<AppEnv>[];
  /** Paths to exclude from metrics collection. Strings use prefix matching. */
  excludePaths?: (string | RegExp)[];
  /** Custom path normalizer to prevent high-cardinality labels. */
  normalizePath?: (path: string) => string;
  /** BullMQ queue names to report depth gauges for. */
  queues?: string[];
  /**
   * Explicitly acknowledge that metrics endpoint is public in production.
   * Set to true only when auth is "none" and you understand the risk.
   * Without this, createApp throws in production when auth is "none".
   */
  unsafePublic?: boolean;
  /**
   * Pluggable unified `MetricsEmitter` exposed on `ctx.metricsEmitter`.
   *
   * @remarks
   * Distinct from the Prometheus-style `/metrics` endpoint above — this is the
   * thin counter/gauge/timing contract that prod-track plugins call from hot
   * paths. When omitted, the framework attaches a no-op emitter so plugins can
   * call it unconditionally. To export to Prometheus or OTel, pass a
   * `MetricsEmitter` that wraps the corresponding client.
   */
  emitter?: MetricsEmitter;
}

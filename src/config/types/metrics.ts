import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

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
}

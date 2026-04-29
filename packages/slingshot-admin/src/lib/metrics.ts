/**
 * In-memory metrics collector for the admin plugin.
 *
 * Tracks request counts, error counts, provider call statistics, and
 * rate-limit hit counts. Data is retained until `reset()` is called
 * (typically during teardown or between test runs).
 *
 * This is a simple counter-based collector. For production observability,
 * forward these metrics to your preferred aggregation pipeline (Prometheus,
 * OpenTelemetry, etc.) by reading the snapshot at regular intervals.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of admin plugin metrics. */
export interface AdminMetricsSnapshot {
  /** Total number of requests processed by admin routes. */
  readonly requestCount: number;
  /** Total number of failed requests. */
  readonly errorCount: number;
  /** Number of calls made to each provider method (e.g. `auth0:verifyRequest`). */
  readonly providerCalls: Record<string, number>;
  /** Number of failed provider calls, keyed by provider method (e.g. `auth0:verifyRequest`). */
  readonly providerFailures: Record<string, number>;
  /** Number of requests rejected by rate limiting. */
  readonly rateLimitHitCount: number;
}

/** Collector interface for admin plugin metrics. */
export interface AdminMetricsCollector {
  /** Record that a request was processed. */
  incrementRequestCount(): void;
  /** Record that a request failed. */
  incrementErrorCount(): void;
  /** Record a provider call. */
  recordProviderCall(providerMethod: string): void;
  /** Record a provider call failure. */
  recordProviderFailure(providerMethod: string): void;
  /** Record a rate-limit rejection. */
  incrementRateLimitHit(): void;
  /** Return a snapshot of the current metrics. */
  getMetrics(): AdminMetricsSnapshot;
  /** Reset all counters to zero. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a metrics collector for the admin plugin.
 *
 * @returns A new `AdminMetricsCollector` with all counters initialised to zero.
 */
export function createAdminMetricsCollector(): AdminMetricsCollector {
  let requestCount = 0;
  let errorCount = 0;
  const providerCalls: Record<string, number> = {};
  const providerFailures: Record<string, number> = {};
  let rateLimitHitCount = 0;

  return {
    incrementRequestCount(): void {
      requestCount++;
    },

    incrementErrorCount(): void {
      errorCount++;
    },

    recordProviderCall(providerMethod: string): void {
      providerCalls[providerMethod] = (providerCalls[providerMethod] ?? 0) + 1;
    },

    recordProviderFailure(providerMethod: string): void {
      providerFailures[providerMethod] =
        (providerFailures[providerMethod] ?? 0) + 1;
    },

    incrementRateLimitHit(): void {
      rateLimitHitCount++;
    },

    getMetrics(): AdminMetricsSnapshot {
      return {
        requestCount,
        errorCount,
        providerCalls: { ...providerCalls },
        providerFailures: { ...providerFailures },
        rateLimitHitCount,
      };
    },

    reset(): void {
      requestCount = 0;
      errorCount = 0;
      for (const key of Object.keys(providerCalls)) delete providerCalls[key];
      for (const key of Object.keys(providerFailures))
        delete providerFailures[key];
      rateLimitHitCount = 0;
    },
  };
}

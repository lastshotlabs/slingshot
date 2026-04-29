import { z } from 'zod';
import { createRoute } from '@lastshotlabs/slingshot-core';
import type { AdminCircuitBreakerHealth } from '../lib/circuitBreaker';
import type { AdminMetricsCollector, AdminMetricsSnapshot } from '../lib/metrics';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const MetricsResponseSchema = z.object({
  requestCount: z.number(),
  errorCount: z.number(),
  providerCalls: z.record(z.string(), z.number()),
  providerFailures: z.record(z.string(), z.number()),
  rateLimitHitCount: z.number(),
  circuitBreakerState: z.enum(['closed', 'open', 'half-open']).optional(),
  uptime: z.number(),
});

const tags = ['Admin'];

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/** Dependencies required by the metrics router. */
export interface MetricsRouterConfig {
  metricsCollector: AdminMetricsCollector;
  getCircuitBreakerHealth?: () => AdminCircuitBreakerHealth;
}

/**
 * Create the admin metrics router.
 *
 * Mounts a `GET /metrics` endpoint that returns operational metrics (request
 * counts, error rates, provider call stats, rate-limit hit count). This
 * endpoint is intentionally mounted before the auth guard middleware so
 * monitoring systems can reach it without admin credentials.
 *
 * @param config - Dependencies for building the metrics response.
 * @returns A typed router with the metrics route registered.
 */
export function createMetricsRouter(config: MetricsRouterConfig) {
  const router = createTypedRouter();
  const { metricsCollector, getCircuitBreakerHealth } = config;

  const startedAt = Date.now();

  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/metrics',
      summary: 'Admin plugin metrics',
      description:
        'Returns operational metrics for the admin plugin: request counts, error rates, provider call statistics.',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: MetricsResponseSchema } },
          description: 'Metrics snapshot.',
        },
      },
    }),
    async c => {
      const metrics: AdminMetricsSnapshot = metricsCollector.getMetrics();
      const cbHealth = getCircuitBreakerHealth?.();

      const response: Record<string, unknown> = {
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        providerCalls: metrics.providerCalls,
        providerFailures: metrics.providerFailures,
        rateLimitHitCount: metrics.rateLimitHitCount,
        uptime: Date.now() - startedAt,
      };

      if (cbHealth) {
        response.circuitBreakerState = cbHealth.state;
      }

      return c.json(response, 200);
    },
  );

  return router;
}

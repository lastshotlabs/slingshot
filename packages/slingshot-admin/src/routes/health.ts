import { z } from 'zod';
import { createRoute } from '@lastshotlabs/slingshot-core';
import type { AdminCircuitBreakerHealth } from '../lib/circuitBreaker';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';
import type { AdminPluginHealth } from '../plugin';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ProviderStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'error', 'not_configured']),
  error: z.string().optional(),
});

const CircuitBreakerStateSchema = z.object({
  state: z.enum(['closed', 'open', 'half-open']),
  consecutiveFailures: z.number(),
  openedAt: z.number().optional(),
  nextProbeAt: z.number().optional(),
});

const HealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  uptime: z.number(),
  providers: z.object({
    accessProvider: ProviderStatusSchema,
    managedUserProvider: ProviderStatusSchema,
    auditLog: ProviderStatusSchema,
    rateLimit: ProviderStatusSchema,
    mailRenderer: ProviderStatusSchema,
  }),
  circuitBreaker: CircuitBreakerStateSchema.optional(),
});

const tags = ['Admin'];

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/** Dependencies required by the health router. */
export interface HealthRouterConfig {
  getPluginHealth: () => AdminPluginHealth;
  getCircuitBreakerHealth?: () => AdminCircuitBreakerHealth;
  /** Provider details for the health response. */
  accessProviderName?: string;
  managedUserProviderName?: string;
}

/**
 * Create the admin health-check router.
 *
 * Mounts a `GET /health` endpoint that returns the aggregated health status
 * of all configured providers and the circuit breaker state. This endpoint
 * is intentionally mounted before the auth guard middleware so monitoring
 * systems can reach it without admin credentials.
 *
 * @param config - Dependencies for building the health response.
 * @returns A typed router with the health route registered.
 */
export function createHealthRouter(config: HealthRouterConfig) {
  const router = createTypedRouter();
  const {
    getPluginHealth,
    getCircuitBreakerHealth,
    accessProviderName = 'unknown',
    managedUserProviderName = 'unknown',
  } = config;

  const startedAt = Date.now();

  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/health',
      summary: 'Admin plugin health',
      description:
        'Returns aggregated health status of all admin providers and the circuit breaker.',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: HealthResponseSchema } },
          description: 'Health status.',
        },
      },
    }),
    async c => {
      const health = getPluginHealth();
      const cbHealth = getCircuitBreakerHealth?.();

      const accessProviderStatus: z.infer<typeof ProviderStatusSchema> = {
        name: accessProviderName,
        status: 'ok',
      };

      const managedUserProviderStatus: z.infer<typeof ProviderStatusSchema> = {
        name: managedUserProviderName,
        status: 'ok',
      };

      let auditLogStatus: z.infer<typeof ProviderStatusSchema>;
      if (health.details.auditLogConfigured) {
        auditLogStatus = { name: 'auditLog', status: 'ok' };
      } else {
        auditLogStatus = { name: 'auditLog', status: 'not_configured' };
      }

      let rateLimitStatus: z.infer<typeof ProviderStatusSchema>;
      if (health.details.rateLimitStoreConfigured) {
        rateLimitStatus = { name: 'rateLimitStore', status: 'ok' };
      } else {
        rateLimitStatus = { name: 'rateLimitStore', status: 'not_configured' };
      }

      const mailRendererStatus: z.infer<typeof ProviderStatusSchema> = {
        name: 'mailRenderer',
        status: health.details.mailRendererConfigured ? 'ok' : 'not_configured',
      };

      // If circuit breaker is open, mark the access provider as degraded
      if (cbHealth?.state === 'open') {
        accessProviderStatus.status = 'error';
        accessProviderStatus.error = `Circuit breaker open after ${cbHealth.consecutiveFailures} consecutive failures`;
      }

      const response: Record<string, unknown> = {
        status: health.status,
        uptime: Date.now() - startedAt,
        providers: {
          accessProvider: accessProviderStatus,
          managedUserProvider: managedUserProviderStatus,
          auditLog: auditLogStatus,
          rateLimit: rateLimitStatus,
          mailRenderer: mailRendererStatus,
        },
      };

      if (cbHealth) {
        response.circuitBreaker = {
          state: cbHealth.state,
          consecutiveFailures: cbHealth.consecutiveFailures,
          openedAt: cbHealth.openedAt,
          nextProbeAt: cbHealth.nextProbeAt,
        };
      }

      return c.json(response, 200);
    },
  );

  return router;
}

import { getContextStoreInfra } from '@framework/persistence/internalRepoResolution';
import { z } from 'zod';
import {
  type PostgresMigrationMode,
  createRoute,
  createRouter,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';

export const router = createRouter();

const postgresReadinessSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  latencyMs: z.number(),
  error: z.string().optional(),
  migrationMode: z.enum(['apply', 'assume-ready']).optional(),
  pool: z
    .object({
      total: z.number(),
      idle: z.number(),
      waiting: z.number(),
    })
    .optional(),
  queries: z
    .object({
      total: z.number(),
      failed: z.number(),
      averageMs: z.number(),
      maxMs: z.number(),
    })
    .optional(),
});

const readinessSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.string(),
  checks: z.object({
    postgres: postgresReadinessSchema.optional(),
  }),
});

function buildPostgresReadiness(
  health: {
    ok: boolean;
    checkedAt: string;
    latencyMs: number;
    error?: string;
  },
  stats?: {
    migrationMode: PostgresMigrationMode;
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    queryCount: number;
    errorCount: number;
    averageQueryDurationMs: number;
    maxQueryDurationMs: number;
  },
): z.infer<typeof postgresReadinessSchema> {
  return {
    ok: health.ok,
    checkedAt: health.checkedAt,
    latencyMs: health.latencyMs,
    error: health.error,
    migrationMode: stats?.migrationMode,
    pool: stats
      ? {
          total: stats.totalCount,
          idle: stats.idleCount,
          waiting: stats.waitingCount,
        }
      : undefined,
    queries: stats
      ? {
          total: stats.queryCount,
          failed: stats.errorCount,
          averageMs: stats.averageQueryDurationMs,
          maxMs: stats.maxQueryDurationMs,
        }
      : undefined,
  };
}

router.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['Core'],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              status: z.enum(['ok']),
              timestamp: z.string(),
            }),
          },
        },
        description: 'Service health check',
      },
    },
  }),
  c => c.json({ status: 'ok' as const, timestamp: new Date().toISOString() }),
);

router.openapi(
  createRoute({
    method: 'get',
    path: '/health/ready',
    tags: ['Core'],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: readinessSchema,
          },
        },
        description: 'Dependency-aware readiness check',
      },
      503: {
        content: {
          'application/json': {
            schema: readinessSchema,
          },
        },
        description: 'One or more required dependencies are unavailable',
      },
    },
  }),
  async c => {
    const ctx = getSlingshotCtx(c);
    const storeInfra = getContextStoreInfra(ctx);
    const checks: z.infer<typeof readinessSchema>['checks'] = {};

    if (storeInfra) {
      try {
        const postgres = storeInfra.getPostgres();
        if (postgres.healthCheck) {
          const [health, stats] = await Promise.all([
            postgres.healthCheck(),
            Promise.resolve(postgres.getStats?.()),
          ]);
          checks.postgres = buildPostgresReadiness(health, stats);
        }
      } catch {
        // Postgres is not configured for this app instance.
      }
    }

    const status: z.infer<typeof readinessSchema>['status'] =
      checks.postgres && !checks.postgres.ok ? 'degraded' : 'ok';
    return c.json(
      { status, timestamp: new Date().toISOString(), checks },
      status === 'ok' ? 200 : 503,
    );
  },
);

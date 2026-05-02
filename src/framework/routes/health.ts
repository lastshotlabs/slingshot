import { getContextStoreInfra } from '@framework/persistence/internalRepoResolution';
import { z } from 'zod';
import {
  type HealthIndicator,
  type HealthIndicatorResult,
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

const indicatorReportSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  severity: z.enum(['critical', 'warning']),
  latencyMs: z.number(),
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const readinessSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.string(),
  checks: z.object({
    postgres: postgresReadinessSchema.optional(),
  }),
  indicators: z.record(z.string(), indicatorReportSchema).optional(),
});

const INDICATOR_TIMEOUT_MS = 5000;

async function runIndicator(
  indicator: HealthIndicator,
  ctx: import('@lastshotlabs/slingshot-core').SlingshotContext,
): Promise<z.infer<typeof indicatorReportSchema>> {
  const severity = indicator.severity ?? 'critical';
  const start = Date.now();
  try {
    const result = await Promise.race<HealthIndicatorResult>([
      indicator.check({ ctx }),
      new Promise<HealthIndicatorResult>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Health indicator '${indicator.name}' timed out`)),
          INDICATOR_TIMEOUT_MS,
        ),
      ),
    ]);
    return {
      status: result.status,
      severity,
      latencyMs: Date.now() - start,
      message: result.message,
      details: result.details,
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      severity,
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

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

    // Run user-defined readiness indicators in parallel.
    const indicatorList = ctx.config.health?.indicators ?? [];
    const indicators: Record<string, z.infer<typeof indicatorReportSchema>> = {};
    let indicatorFailureSeverity: 'critical' | 'warning' | null = null;
    if (indicatorList.length > 0) {
      const reports = await Promise.all(indicatorList.map(ind => runIndicator(ind, ctx)));
      for (let i = 0; i < indicatorList.length; i += 1) {
        const ind = indicatorList[i];
        const report = reports[i];
        if (!ind || !report) continue;
        indicators[ind.name] = report;
        if (report.status === 'unhealthy' || report.status === 'degraded') {
          // Critical wins over warning when both are present.
          if (report.severity === 'critical') {
            indicatorFailureSeverity = 'critical';
          } else if (indicatorFailureSeverity !== 'critical') {
            indicatorFailureSeverity = 'warning';
          }
        }
      }
    }

    const postgresFailing = checks.postgres && !checks.postgres.ok;
    const isCriticalDown = postgresFailing || indicatorFailureSeverity === 'critical';
    const isDegraded = !isCriticalDown && indicatorFailureSeverity === 'warning';
    const status: z.infer<typeof readinessSchema>['status'] =
      isCriticalDown || isDegraded ? 'degraded' : 'ok';
    const httpStatus = isCriticalDown ? 503 : 200;
    return c.json(
      {
        status,
        timestamp: new Date().toISOString(),
        checks,
        ...(Object.keys(indicators).length > 0 ? { indicators } : {}),
      },
      httpStatus,
    );
  },
);

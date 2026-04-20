import { getAuthenticatedAccountGuardFailure } from '@framework/lib/authRouteGuard';
import type { MetricsState } from '@framework/metrics/registry';
import {
  registerGaugeCallback,
  serializeMetrics,
  setMetricsQueues,
} from '@framework/metrics/registry';
import type { QueueFactory } from '@lib/queue';
import type { Queue as BullMQQueue } from 'bullmq';
import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  type PostgresBundle,
  createRouter,
  getRouteAuth,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for the `/metrics` Prometheus scrape endpoint.
 */
export interface MetricsRouteConfig {
  /**
   * Access control for the `/metrics` endpoint.
   *
   * - `"userAuth"` — requires a valid user session (cookie or `x-user-token`).
   * - `"none"` — no authentication (requires `unsafePublic: true` in production).
   * - `MiddlewareHandler[]` — custom middleware chain applied before the route.
   *
   * Default: `"none"`.
   */
  auth?: 'userAuth' | 'none' | MiddlewareHandler<AppEnv>[];
  /**
   * BullMQ queue names to expose as `bullmq_queue_depth` gauge metrics.
   * Job counts are scraped per queue per state (waiting, active, delayed, failed).
   * Requires a `QueueFactory` to be passed to `createMetricsRouter`.
   */
  queues?: string[];
  /**
   * Explicitly permit `auth: "none"` in production.
   * Only set this if the `/metrics` endpoint is protected by network-level ACLs.
   */
  unsafePublic?: boolean;
}

/**
 * Create a Hono router that serves a Prometheus-compatible `/metrics` endpoint.
 *
 * Serialises the provided `MetricsState` in the Prometheus text exposition
 * format (`text/plain; version=0.0.4`) on `GET /metrics`.
 *
 * When `config.queues` is provided and a `queueFactory` is supplied, the router
 * also registers a `bullmq_queue_depth` gauge that is populated on each scrape
 * by querying BullMQ for job counts across waiting, active, delayed, and failed
 * states.  Queue instances are cached in-memory across scrapes; errors during
 * scrape are suppressed (the cached instance is evicted so it is recreated on
 * the next attempt).
 *
 * @param config - Metrics route configuration (auth, queues, unsafePublic, isProd).
 * @param state - Instance-owned `MetricsState` to serialise.
 * @param queueFactory - Optional factory for creating BullMQ `Queue` instances.
 *   Required when `config.queues` is non-empty.
 * @returns A Hono router with a single `GET /metrics` route.
 * @throws {Error} In production when `config.auth === "none"` and
 *   `config.unsafePublic` is not set.
 * @throws {Error} When `config.queues` is non-empty but `queueFactory` is not
 *   provided.
 */
export const createMetricsRouter = (
  config: MetricsRouteConfig & { isProd: boolean },
  state: MetricsState,
  queueFactory?: QueueFactory,
  postgres?: PostgresBundle | null,
) => {
  const router = createRouter();
  const authConfig = config.auth ?? 'none';

  const isProd = config.isProd;
  if (isProd && authConfig === 'none' && !config.unsafePublic) {
    throw new Error(
      '[security] metrics.auth is required in production. Set metrics.auth or set unsafePublic: true.',
    );
  }

  // Apply auth middleware
  if (authConfig === 'userAuth') {
    router.use('/metrics', (c: Context<AppEnv, string>, next: Next) =>
      getRouteAuth(getSlingshotCtx(c)).userAuth(c, next),
    );
    router.use('/metrics', async (c, next) => {
      const guardFailure = await getAuthenticatedAccountGuardFailure(c);
      if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
      await next();
    });
  } else if (Array.isArray(authConfig)) {
    for (const mw of authConfig) {
      router.use('/metrics', mw);
    }
  }

  // Register BullMQ queue depth gauges if configured
  if (config.queues?.length) {
    if (!queueFactory) {
      throw new Error(
        '[queue] Metrics queue gauges require startup-resolved Redis queue configuration.',
      );
    }
    const queueNames = config.queues;
    const cachedQueues = new Map<string, BullMQQueue>();
    setMetricsQueues(state, cachedQueues);

    registerGaugeCallback(state, 'bullmq_queue_depth', async () => {
      const results: { labels: { queue: string; state: string }; value: number }[] = [];

      for (const name of queueNames) {
        let queue = cachedQueues.get(name);
        try {
          if (!queue) {
            queue = queueFactory.createQueue(name);
            cachedQueues.set(name, queue);
          }
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          for (const [state, count] of Object.entries(counts)) {
            results.push({ labels: { queue: name, state }, value: count });
          }
        } catch {
          // Discard cached instance on error so it's recreated next scrape
          cachedQueues.delete(name);
        }
      }

      return results;
    });
  }

  const getPostgresStats = postgres?.getStats;
  if (getPostgresStats) {
    registerGaugeCallback(state, 'slingshot_postgres_pool_clients', async () => {
      const stats = getPostgresStats();
      return [
        { labels: { state: 'total' }, value: stats.totalCount },
        { labels: { state: 'idle' }, value: stats.idleCount },
        { labels: { state: 'waiting' }, value: stats.waitingCount },
      ];
    });

    registerGaugeCallback(state, 'slingshot_postgres_query_count', async () => {
      const stats = getPostgresStats();
      return [
        { labels: { state: 'total' }, value: stats.queryCount },
        { labels: { state: 'failed' }, value: stats.errorCount },
      ];
    });

    registerGaugeCallback(state, 'slingshot_postgres_query_latency_ms', async () => {
      const stats = getPostgresStats();
      return [
        { labels: { stat: 'average' }, value: stats.averageQueryDurationMs },
        { labels: { stat: 'max' }, value: stats.maxQueryDurationMs },
      ];
    });

    registerGaugeCallback(state, 'slingshot_postgres_migration_mode', async () => {
      const stats = getPostgresStats();
      return [{ labels: { mode: stats.migrationMode }, value: 1 }];
    });
  }

  // Plain GET /metrics (not OpenAPI — infrastructure endpoint)
  router.get('/metrics', async c => {
    const body = await serializeMetrics(state);
    return c.body(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  return router;
};

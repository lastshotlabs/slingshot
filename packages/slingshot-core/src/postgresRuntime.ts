type PoolShape = {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

/** Whether the Postgres runtime applies migrations on startup or assumes the schema is already migrated. */
export type PostgresMigrationMode = 'apply' | 'assume-ready';

/** Immutable point-in-time view of a Postgres pool's connection counts and query/error statistics. */
export interface PostgresPoolStatsSnapshot {
  readonly migrationMode: PostgresMigrationMode;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly queryCount: number;
  readonly errorCount: number;
  readonly averageQueryDurationMs: number;
  readonly maxQueryDurationMs: number;
  readonly lastErrorAt: string | null;
}

/** Outcome of a Postgres connectivity probe: success flag, latency, timestamp, and any error message. */
export interface PostgresHealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly checkedAt: string;
  readonly error?: string;
}

/** Per-pool runtime that records query timings/failures and produces {@link PostgresPoolStatsSnapshot}s. */
export interface PostgresPoolRuntime {
  readonly migrationMode: PostgresMigrationMode;
  readonly healthcheckTimeoutMs: number;
  recordQuery(durationMs: number, failed: boolean): void;
  snapshot(pool: PoolShape): PostgresPoolStatsSnapshot;
}

const POOL_RUNTIME = new WeakMap<object, PostgresPoolRuntime>();

/** Create a {@link PostgresPoolRuntime} that accumulates query-count, error, and duration metrics for a pool. */
export function createPostgresPoolRuntime(opts?: {
  migrationMode?: PostgresMigrationMode;
  healthcheckTimeoutMs?: number;
}): PostgresPoolRuntime {
  let queryCount = 0;
  let errorCount = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let lastErrorAt: string | null = null;

  const migrationMode = opts?.migrationMode ?? 'apply';
  const healthcheckTimeoutMs = Math.max(1, opts?.healthcheckTimeoutMs ?? 1_000);

  return {
    migrationMode,
    healthcheckTimeoutMs,
    recordQuery(durationMs, failed) {
      queryCount++;
      totalDurationMs += durationMs;
      maxDurationMs = Math.max(maxDurationMs, durationMs);
      if (failed) {
        errorCount++;
        lastErrorAt = new Date().toISOString();
      }
    },
    snapshot(pool) {
      const totalCount = Number(pool.totalCount ?? 0);
      const idleCount = Number(pool.idleCount ?? 0);
      const waitingCount = Number(pool.waitingCount ?? 0);
      return {
        migrationMode,
        totalCount,
        idleCount,
        waitingCount,
        queryCount,
        errorCount,
        averageQueryDurationMs: queryCount === 0 ? 0 : totalDurationMs / queryCount,
        maxQueryDurationMs: maxDurationMs,
        lastErrorAt,
      };
    },
  };
}

/** Associate a {@link PostgresPoolRuntime} with a pool instance via a weak map for later lookup. */
export function attachPostgresPoolRuntime(pool: object, runtime: PostgresPoolRuntime): void {
  POOL_RUNTIME.set(pool, runtime);
}

/** Retrieve the {@link PostgresPoolRuntime} previously attached to a pool, or `null` if none. */
export function getPostgresPoolRuntime(pool: object): PostgresPoolRuntime | null {
  return POOL_RUNTIME.get(pool) ?? null;
}

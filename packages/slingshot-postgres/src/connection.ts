import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  attachPostgresPoolRuntime,
  createPostgresPoolRuntime,
  type PostgresHealthCheckResult,
  type PostgresMigrationMode,
  type PostgresPoolStatsSnapshot,
} from '@lastshotlabs/slingshot-core';

/**
 * A connected Postgres handle bundling a raw `pg.Pool` and a Drizzle ORM client.
 *
 * - `pool` — passed to plugin adapters that accept a raw `pg.Pool` (permissions, push, webhooks).
 * - `db` — passed to Drizzle-based adapters such as `createPostgresAdapter` (auth).
 */
export interface DrizzlePostgresDb {
  /** Raw `pg.Pool` for plugin adapters that work directly with parameterized SQL. */
  readonly pool: Pool;
  /** Drizzle ORM client wrapping the same pool, used by `createPostgresAdapter`. */
  readonly db: NodePgDatabase;
  /** Active Postgres readiness probe. */
  readonly healthCheck: (timeoutMs?: number) => Promise<PostgresHealthCheckResult>;
  /** Runtime pool and query statistics for observability endpoints. */
  readonly getStats: () => PostgresPoolStatsSnapshot;
}

export interface PostgresPoolConfig {
  readonly max?: number;
  readonly min?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxUses?: number;
  readonly allowExitOnIdle?: boolean;
  readonly keepAlive?: boolean;
  readonly keepAliveInitialDelayMillis?: number;
}

export interface PostgresConnectionOptions {
  readonly pool?: PostgresPoolConfig;
  readonly migrations?: PostgresMigrationMode;
  readonly healthcheckTimeoutMs?: number;
}

type Queryable = {
  query: (...args: unknown[]) => Promise<unknown>;
};

type InstrumentedClient = Queryable & {
  __slingshotInstrumented?: boolean;
};

function wrapQueryableQueries(target: Queryable, recordQuery: (durationMs: number, failed: boolean) => void): void {
  const originalQuery = target.query.bind(target);
  target.query = (async (...args: unknown[]) => {
    const startedAt = performance.now();
    try {
      const result = await originalQuery(...args);
      recordQuery(performance.now() - startedAt, false);
      return result;
    } catch (error) {
      recordQuery(performance.now() - startedAt, true);
      throw error;
    }
  }) as Queryable['query'];
}

function instrumentPool(pool: Pool, recordQuery: (durationMs: number, failed: boolean) => void): void {
  wrapQueryableQueries(pool as unknown as Queryable, recordQuery);

  if (typeof pool.connect !== 'function') return;

  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as Pool & { connect: (...args: unknown[]) => unknown }).connect = (async (...args: unknown[]) => {
    const client = await originalConnect(...args);
    if (!client || typeof client !== 'object' || !('query' in client)) {
      return client;
    }
    const instrumented = client as InstrumentedClient;
    if (!instrumented.__slingshotInstrumented) {
      wrapQueryableQueries(client as unknown as Queryable, recordQuery);
      instrumented.__slingshotInstrumented = true;
    }
    return client;
  }) as unknown as typeof pool.connect;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function checkPostgresHealth(
  pool: Pool,
  defaultTimeoutMs: number,
  timeoutMs?: number,
): Promise<PostgresHealthCheckResult> {
  const effectiveTimeoutMs = Math.max(1, timeoutMs ?? defaultTimeoutMs);
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    await withTimeout(
      pool.query('SELECT 1'),
      effectiveTimeoutMs,
      `[slingshot-postgres] readiness check exceeded ${effectiveTimeoutMs}ms`,
    );
    return {
      ok: true,
      latencyMs: performance.now() - startedAt,
      checkedAt,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: performance.now() - startedAt,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Opens a Postgres connection pool and returns a bundled `{ pool, db }` handle.
 *
 * The pool is eagerly verified with a `SELECT 1` query to surface connectivity problems at
 * startup rather than at first request (fail-fast). Both `pool` and `db` share the same
 * underlying connection pool.
 *
 * @param connectionString - A `postgresql://` connection string.
 * @returns A `DrizzlePostgresDb` handle with a verified, live connection.
 * @throws {Error} If the Postgres server is unreachable or credentials are invalid.
 *
 * @example
 * ```ts
 * import { connectPostgres } from '@lastshotlabs/slingshot-postgres';
 *
 * const db = await connectPostgres(process.env.DATABASE_URL!);
 * // Pass db.pool to permission/push/webhook adapters.
 * // Pass db to createPostgresAdapter for auth.
 * ```
 */
export async function connectPostgres(
  connectionString: string,
  options: PostgresConnectionOptions = {},
): Promise<DrizzlePostgresDb> {
  const pool = new Pool({
    connectionString,
    max: options.pool?.max,
    min: options.pool?.min,
    idleTimeoutMillis: options.pool?.idleTimeoutMs,
    connectionTimeoutMillis: options.pool?.connectionTimeoutMs,
    query_timeout: options.pool?.queryTimeoutMs,
    statement_timeout: options.pool?.statementTimeoutMs,
    maxUses: options.pool?.maxUses,
    allowExitOnIdle: options.pool?.allowExitOnIdle,
    keepAlive: options.pool?.keepAlive,
    keepAliveInitialDelayMillis: options.pool?.keepAliveInitialDelayMillis,
  });
  const runtime = createPostgresPoolRuntime({
    migrationMode: options.migrations,
    healthcheckTimeoutMs: options.healthcheckTimeoutMs ?? options.pool?.queryTimeoutMs,
  });
  attachPostgresPoolRuntime(pool, runtime);
  instrumentPool(pool, (durationMs, failed) => runtime.recordQuery(durationMs, failed));
  await pool.query('SELECT 1'); // verify connectivity eagerly
  const db = drizzle(pool);
  return {
    pool,
    db,
    healthCheck: timeoutMs => checkPostgresHealth(pool, runtime.healthcheckTimeoutMs, timeoutMs),
    getStats: () => runtime.snapshot(pool),
  };
}

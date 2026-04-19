import { Pool } from 'pg';

export interface PostgresCapacitySmokeConfig {
  connectionString: string;
  concurrency: number;
  iterationsPerWorker: number;
  query: string;
}

export interface PostgresCapacitySmokeSummary extends PostgresCapacitySmokeConfig {
  totalQueries: number;
  successfulQueries: number;
  failures: number;
  totalDurationMs: number;
  queriesPerSecond: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
}

type QueryablePool = {
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<unknown>;
};

type PoolFactory = (options: { connectionString: string; max: number }) => QueryablePool;

type PerfLike = {
  now: () => number;
};

type ConsoleLike = {
  log: (message: string) => void;
  error: (...values: unknown[]) => void;
};

export function resolvePostgresCapacitySmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PostgresCapacitySmokeConfig {
  return {
    connectionString:
      env.POSTGRES_URL ??
      env.DATABASE_URL ??
      env.TEST_POSTGRES_URL ??
      'postgresql://postgres:postgres@localhost:5433/slingshot_test',
    concurrency: Number.parseInt(env.PG_SMOKE_CONCURRENCY ?? '16', 10),
    iterationsPerWorker: Number.parseInt(env.PG_SMOKE_ITERATIONS ?? '100', 10),
    query: env.PG_SMOKE_QUERY ?? 'SELECT 1',
  };
}

export function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index] ?? 0;
}

export async function runPostgresCapacitySmoke(
  config = resolvePostgresCapacitySmokeConfig(),
  dependencies: {
    createPool?: PoolFactory;
    performance?: PerfLike;
  } = {},
): Promise<PostgresCapacitySmokeSummary> {
  if (!Number.isFinite(config.concurrency) || config.concurrency < 1) {
    throw new Error('PG_SMOKE_CONCURRENCY must be a positive integer');
  }
  if (!Number.isFinite(config.iterationsPerWorker) || config.iterationsPerWorker < 1) {
    throw new Error('PG_SMOKE_ITERATIONS must be a positive integer');
  }

  const createPool =
    dependencies.createPool ??
    ((options: { connectionString: string; max: number }) => new Pool(options));
  const perf = dependencies.performance ?? performance;

  const pool = createPool({
    connectionString: config.connectionString,
    max: Math.max(config.concurrency, 4),
  });

  const latenciesMs: number[] = [];
  let failures = 0;
  const startedAt = perf.now();

  try {
    await Promise.all(
      Array.from({ length: config.concurrency }, async () => {
        for (let i = 0; i < config.iterationsPerWorker; i++) {
          const queryStartedAt = perf.now();
          try {
            await pool.query(config.query);
            latenciesMs.push(perf.now() - queryStartedAt);
          } catch {
            failures++;
          }
        }
      }),
    );
  } finally {
    await pool.end();
  }

  const totalDurationMs = perf.now() - startedAt;
  const totalQueries = config.concurrency * config.iterationsPerWorker;
  const successfulQueries = latenciesMs.length;
  const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
  const averageLatencyMs =
    successfulQueries === 0 ? 0 : latenciesMs.reduce((sum, value) => sum + value, 0) / successfulQueries;

  return {
    connectionString: config.connectionString,
    query: config.query,
    concurrency: config.concurrency,
    iterationsPerWorker: config.iterationsPerWorker,
    totalQueries,
    successfulQueries,
    failures,
    totalDurationMs,
    queriesPerSecond: totalDurationMs === 0 ? 0 : (successfulQueries / totalDurationMs) * 1_000,
    averageLatencyMs,
    p50LatencyMs: percentile(sortedLatencies, 0.5),
    p95LatencyMs: percentile(sortedLatencies, 0.95),
    p99LatencyMs: percentile(sortedLatencies, 0.99),
    maxLatencyMs: sortedLatencies[sortedLatencies.length - 1] ?? 0,
  };
}

export async function runPostgresCapacitySmokeCli(
  env: NodeJS.ProcessEnv = process.env,
  logger: ConsoleLike = console,
  dependencies: {
    createPool?: PoolFactory;
    performance?: PerfLike;
  } = {},
): Promise<number> {
  try {
    const summary = await runPostgresCapacitySmoke(
      resolvePostgresCapacitySmokeConfig(env),
      dependencies,
    );
    logger.log(JSON.stringify(summary, null, 2));
    return summary.failures > 0 ? 1 : 0;
  } catch (error) {
    logger.error(
      '[postgres-capacity-smoke]',
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runPostgresCapacitySmokeCli();
}

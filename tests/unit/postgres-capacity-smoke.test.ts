import { describe, expect, test } from 'bun:test';

import {
  percentile,
  resolvePostgresCapacitySmokeConfig,
  runPostgresCapacitySmoke,
  runPostgresCapacitySmokeCli,
} from '../../scripts/postgres-capacity-smoke.ts';

describe('postgres capacity smoke script', () => {
  test('resolves configuration from environment variables with sane defaults', () => {
    expect(
      resolvePostgresCapacitySmokeConfig({
        POSTGRES_URL: 'postgres://primary',
        PG_SMOKE_CONCURRENCY: '8',
        PG_SMOKE_ITERATIONS: '25',
        PG_SMOKE_QUERY: 'SELECT 42',
      }),
    ).toEqual({
      connectionString: 'postgres://primary',
      concurrency: 8,
      iterationsPerWorker: 25,
      query: 'SELECT 42',
    });

    expect(
      resolvePostgresCapacitySmokeConfig({
        DATABASE_URL: 'postgres://fallback',
      }),
    ).toEqual({
      connectionString: 'postgres://fallback',
      concurrency: 16,
      iterationsPerWorker: 100,
      query: 'SELECT 1',
    });
  });

  test('computes percentiles across empty and populated latency sets', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5, 10, 15, 20], 0.5)).toBe(10);
    expect(percentile([5, 10, 15, 20], 0.95)).toBe(20);
  });

  test('runs the configured query workload and summarizes successes and failures', async () => {
    const queryCalls: string[] = [];
    let ended = false;
    let now = 0;
    let attempt = 0;

    const summary = await runPostgresCapacitySmoke(
      {
        connectionString: 'postgres://smoke',
        concurrency: 2,
        iterationsPerWorker: 3,
        query: 'SELECT 7',
      },
      {
        createPool: options => {
          expect(options).toEqual({
            connectionString: 'postgres://smoke',
            max: 4,
          });

          return {
            async query(sql: string) {
              queryCalls.push(sql);
              attempt += 1;
              if (attempt === 2 || attempt === 5) {
                throw new Error('simulated failure');
              }
            },
            async end() {
              ended = true;
            },
          };
        },
        performance: {
          now: () => {
            now += 5;
            return now;
          },
        },
      },
    );

    expect(queryCalls).toEqual(['SELECT 7', 'SELECT 7', 'SELECT 7', 'SELECT 7', 'SELECT 7', 'SELECT 7']);
    expect(ended).toBe(true);
    expect(summary).toMatchObject({
      connectionString: 'postgres://smoke',
      query: 'SELECT 7',
      concurrency: 2,
      iterationsPerWorker: 3,
      totalQueries: 6,
      successfulQueries: 4,
      failures: 2,
      totalDurationMs: 55,
      averageLatencyMs: 10,
      p50LatencyMs: 10,
      p95LatencyMs: 15,
      p99LatencyMs: 15,
      maxLatencyMs: 15,
    });
    expect(summary.queriesPerSecond).toBeCloseTo(72.727, 3);
  });

  test('rejects invalid concurrency and iteration counts', async () => {
    await expect(
      runPostgresCapacitySmoke({
        connectionString: 'postgres://smoke',
        concurrency: 0,
        iterationsPerWorker: 1,
        query: 'SELECT 1',
      }),
    ).rejects.toThrow('PG_SMOKE_CONCURRENCY must be a positive integer');

    await expect(
      runPostgresCapacitySmoke({
        connectionString: 'postgres://smoke',
        concurrency: 1,
        iterationsPerWorker: Number.NaN,
        query: 'SELECT 1',
      }),
    ).rejects.toThrow('PG_SMOKE_ITERATIONS must be a positive integer');
  });

  test('reports CLI success, failures, and startup errors via exit codes', async () => {
    const messages: string[] = [];
    const errors: unknown[][] = [];

    const successCode = await runPostgresCapacitySmokeCli(
      {
        POSTGRES_URL: 'postgres://smoke',
        PG_SMOKE_CONCURRENCY: '1',
        PG_SMOKE_ITERATIONS: '1',
        PG_SMOKE_QUERY: 'SELECT 1',
      },
      {
        log: message => messages.push(message),
        error: (...values: unknown[]) => errors.push(values),
      },
      {
        createPool: () => ({
          async query() {
            return { rows: [{ '?column?': 1 }] };
          },
          async end() {},
        }),
        performance: {
          now: (() => {
            let now = 0;
            return () => {
              now += 10;
              return now;
            };
          })(),
        },
      },
    );
    expect(successCode).toBe(0);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0] ?? '{}')).toMatchObject({
      successfulQueries: 1,
      failures: 0,
    });

    const failureCode = await runPostgresCapacitySmokeCli(
      {
        PG_SMOKE_CONCURRENCY: '0',
      },
      {
        log: message => messages.push(message),
        error: (...values: unknown[]) => errors.push(values),
      },
    );
    expect(failureCode).toBe(1);
    expect(errors.at(-1)).toEqual([
      '[postgres-capacity-smoke]',
      'PG_SMOKE_CONCURRENCY must be a positive integer',
    ]);
  });
});

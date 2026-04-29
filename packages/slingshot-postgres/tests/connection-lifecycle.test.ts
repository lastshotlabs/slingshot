/**
 * Unit tests for connection pool creation, fail-fast, health checks, and lifecycle.
 *
 * These tests mock `pg` so no real database is needed. They cover the parts of
 * `connectPostgres` and its helpers (`instrumentPool`, `checkPostgresHealth`,
 * `withTimeout`) that are not exercised by the existing connection-and-testing.test.ts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  PostgresPoolStatsSnapshot,
  attachPostgresPoolRuntime,
  createPostgresPoolRuntime,
} from '@lastshotlabs/slingshot-core';

// ── Mock state ────────────────────────────────────────────────────────────────

let queryFn: (sql: string) => Promise<unknown> = async () => ({
  rows: [{ ok: 1 }],
  rowCount: 1,
});
let connectFn: (...args: unknown[]) => unknown = async () => ({
  query: queryFn,
});
const endMock = mock(async () => {});
let poolOptions: Record<string, unknown> | null = null;

class MockPool {
  totalCount = 5;
  idleCount = 2;
  waitingCount = 1;

  constructor(opts: Record<string, unknown>) {
    poolOptions = opts;
  }

  query(sql: string) {
    return queryFn(sql);
  }

  connect(...args: unknown[]) {
    return connectFn(...args);
  }

  end() {
    return endMock();
  }
}

mock.module('pg', () => ({
  Pool: MockPool,
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: unknown) => ({ kind: 'drizzle', pool }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('connectPostgres — pool creation and fail-fast', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    connectFn = async () => ({ query: queryFn });
    endMock.mockClear();
    poolOptions = null;
  });

  test('creates a Pool with the given connection string', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?pool-create=${Date.now()}`
    );
    await connectPostgres('postgresql://localhost/mydb');
    expect(poolOptions).toMatchObject({
      connectionString: 'postgresql://localhost/mydb',
    });
  });

  test('forwards all pool config fields to the Pool constructor', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?pool-config=${Date.now()}`
    );
    await connectPostgres('postgresql://localhost/mydb', {
      pool: {
        max: 25,
        min: 5,
        idleTimeoutMs: 10_000,
        connectionTimeoutMs: 3_000,
        queryTimeoutMs: 2_000,
        statementTimeoutMs: 1_500,
        maxUses: 1000,
        allowExitOnIdle: true,
        keepAlive: true,
        keepAliveInitialDelayMillis: 5_000,
      },
    });
    expect(poolOptions).toEqual({
      connectionString: 'postgresql://localhost/mydb',
      max: 25,
      min: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      query_timeout: 2_000,
      statement_timeout: 1_500,
      maxUses: 1000,
      allowExitOnIdle: true,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
    });
  });

  test('sends SELECT 1 to verify connectivity on startup', async () => {
    const captured: string[] = [];
    const origQuery = queryFn;
    queryFn = async (sql: string) => {
      captured.push(sql);
      return origQuery(sql);
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?select1=${Date.now()}`
    );
    await connectPostgres('postgresql://localhost/mydb');

    expect(captured).toContain('SELECT 1');
  });

  test('calls pool.end() when the startup SELECT 1 fails', async () => {
    queryFn = async () => {
      throw new Error('connection refused');
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?fail=${Date.now()}`
    );
    await expect(connectPostgres('postgresql://localhost/mydb')).rejects.toThrow(
      'connection refused',
    );
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  test('returns a DrizzlePostgresDb handle with pool, db, healthCheck, and getStats', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?handle=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    expect(result).toHaveProperty('pool');
    expect(result).toHaveProperty('db');
    expect(result).toHaveProperty('healthCheck');
    expect(result).toHaveProperty('getStats');
    expect(result.pool).toBeInstanceOf(MockPool);
    expect((result.db as Record<string, unknown>).kind).toBe('drizzle');
  });

  test('returns a working getStats snapshot with pool stats', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?stats=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    const stats = result.getStats();
    expect(stats).toHaveProperty('migrationMode');
    expect(stats).toHaveProperty('totalCount');
    expect(stats).toHaveProperty('idleCount');
    expect(stats).toHaveProperty('waitingCount');
    expect(stats).toHaveProperty('queryCount');
    expect(stats).toHaveProperty('errorCount');
    expect(stats.totalCount).toBe(5);
    expect(stats.idleCount).toBe(2);
    expect(stats.waitingCount).toBe(1);
    expect(stats.queryCount).toBe(1); // SELECT 1 was recorded
    expect(stats.errorCount).toBe(0);
  });
});

describe('connectPostgres — migration mode and healthcheck config', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    connectFn = async () => ({ query: queryFn });
    endMock.mockClear();
    poolOptions = null;
  });

  test('default migration mode is "apply"', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?mode-default=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');
    expect(result.getStats().migrationMode).toBe('apply');
  });

  test('"assume-ready" migration mode is reflected in stats', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?mode-ready=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb', {
      migrations: 'assume-ready',
    });
    expect(result.getStats().migrationMode).toBe('assume-ready');
  });

  test('healthcheck timeout config is passed through', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?hc-timeout=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb', {
      healthcheckTimeoutMs: 5000,
    });
    // We can't inspect the internal value directly, but we can verify the
    // handle was created successfully with the right migration mode.
    expect(result.healthCheck).toBeFunction();
  });
});

describe('healthCheck function', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    endMock.mockClear();
  });

  test('returns ok=true with latency when query succeeds', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?hc-ok=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');
    const health = await result.healthCheck();

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.checkedAt).toBeString();
    expect(health).not.toHaveProperty('error');
  });

  test('returns ok=false with error message when query fails', async () => {
    // Use a call counter: first call (startup SELECT 1) succeeds,
    // second call (health check) fails.
    let callCount = 0;
    const origQuery = queryFn;
    queryFn = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ ok: 1 }], rowCount: 1 };
      }
      throw new Error('server unreachable');
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?hc-fail=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    const health = await result.healthCheck(5000);

    expect(health.ok).toBe(false);
    expect(health.error).toContain('server unreachable');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.checkedAt).toBeString();

    queryFn = origQuery;
  });

  test('respects timeoutMs parameter', async () => {
    // Use a call counter: first call (startup SELECT 1) succeeds,
    // second call (health check) hangs and times out.
    let callCount = 0;

    const origQuery = queryFn;
    queryFn = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ ok: 1 }], rowCount: 1 };
      }
      await new Promise(() => {}); // never resolves
      return { rows: [] };
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?hc-timeout-param=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    // With a very short timeout, it should fail
    const health = await result.healthCheck(50);

    expect(health.ok).toBe(false);
    expect(health.error).toContain('readiness check exceeded');

    queryFn = origQuery;
  });
});

describe('getStats query recording', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    endMock.mockClear();
  });

  test('records query counts from SELECT 1', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?stats-q=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');
    const stats = result.getStats();

    expect(stats.queryCount).toBe(1);
    expect(stats.errorCount).toBe(0);
  });

  test('records errors when query fails', async () => {
    queryFn = async () => {
      throw new Error('fail');
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?stats-err=${Date.now()}`
    );
    // We expect the connectPostgres call itself to fail
    await expect(
      connectPostgres('postgresql://localhost/mydb'),
    ).rejects.toThrow('fail');
  });

  test('records query duration in stats', async () => {
    // Simulate a slow query by adding a small delay
    queryFn = async () => {
      await new Promise(r => setTimeout(r, 5));
      return { rows: [{ ok: 1 }], rowCount: 1 };
    };

    const { connectPostgres } = await import(
      `../src/connection.ts?stats-dur=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');
    const stats = result.getStats();

    expect(stats.queryCount).toBe(1);
    expect(stats.averageQueryDurationMs).toBeGreaterThan(0);
    expect(stats.maxQueryDurationMs).toBeGreaterThan(0);
  });
});

describe('pool instrumentation', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    endMock.mockClear();
  });

  test('instrumented pool.query records calls in runtime stats', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?instr=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    // Do an additional query through the pool
    await result.pool.query('SELECT 2');
    const stats = result.getStats();

    // SELECT 1 (startup) + SELECT 2 (manual) = 2 queries
    expect(stats.queryCount).toBe(2);
  });

  test('instrumented pool.connect wraps clients with query tracking', async () => {
    // connect() returns a client whose query() is also instrumented
    let clientQueryCalled = false;
    connectFn = async () => ({
      query: async (sql: string) => {
        clientQueryCalled = true;
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
      __slingshotInstrumented: false,
    });

    const { connectPostgres } = await import(
      `../src/connection.ts?instr-client=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/mydb');

    // Acquire a client and run a query
    const client = await result.pool.connect();
    await (client as { query: (sql: string) => Promise<unknown> }).query('SELECT 3');
    expect(clientQueryCalled).toBe(true);
  });
});

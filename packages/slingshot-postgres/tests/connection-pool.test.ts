/**
 * Connection-pool tests for slingshot-postgres.
 *
 * Covers pool creation, max connections, idle timeout, connection errors,
 * and query timeout behaviour through connectPostgres.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createPostgresPoolRuntime } from '@lastshotlabs/slingshot-core';

// ── Mock state ─────────────────────────────────────────────────────────────

let queryFn: (sql: string) => Promise<unknown> = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
let connectFn: (...args: unknown[]) => unknown = async () => ({ query: queryFn, release() {} });
let poolConstructorOpts: Record<string, unknown> | null = null;
let poolTotalCount = 5;
let poolIdleCount = 2;
let poolWaitingCount = 1;

class MockPool {
  totalCount = poolTotalCount;
  idleCount = poolIdleCount;
  waitingCount = poolWaitingCount;

  constructor(opts: Record<string, unknown>) {
    poolConstructorOpts = opts;
  }

  query(sql: string) {
    return queryFn(sql);
  }
  connect(...args: unknown[]) {
    return connectFn(...args);
  }
  end() {
    return Promise.resolve();
  }
}

mock.module('pg', () => ({ Pool: MockPool }));
mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: unknown) => ({ kind: 'drizzle', pool }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('connectPostgres — pool options', () => {
  beforeEach(() => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    connectFn = async () => ({ query: queryFn, release() {} });
    poolConstructorOpts = null;
    poolTotalCount = 5;
    poolIdleCount = 2;
    poolWaitingCount = 1;
  });

  test('forwards max connections to Pool constructor', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-max=${Date.now()}`);
    await connectPostgres('postgresql://localhost/db', { pool: { max: 50 } });
    expect(poolConstructorOpts).toMatchObject({ max: 50 });
  });

  test('forwards idle timeout to Pool constructor', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-idle=${Date.now()}`);
    await connectPostgres('postgresql://localhost/db', { pool: { idleTimeoutMs: 15000 } });
    expect(poolConstructorOpts).toMatchObject({ idleTimeoutMillis: 15000 });
  });

  test('forwards connection timeout to Pool constructor', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-cto=${Date.now()}`);
    await connectPostgres('postgresql://localhost/db', { pool: { connectionTimeoutMs: 5000 } });
    expect(poolConstructorOpts).toMatchObject({ connectionTimeoutMillis: 5000 });
  });

  test('forwards keepAlive settings to Pool constructor', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-ka=${Date.now()}`);
    await connectPostgres('postgresql://localhost/db', {
      pool: { keepAlive: true, keepAliveInitialDelayMillis: 10000 },
    });
    expect(poolConstructorOpts).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
  });

  test('connection string is passed through', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-cs=${Date.now()}`);
    await connectPostgres('postgresql://user:pass@host:5432/mydb');
    expect(poolConstructorOpts).toMatchObject({
      connectionString: 'postgresql://user:pass@host:5432/mydb',
    });
  });

  test('returns a handle with pool, db, healthCheck, and getStats', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-handle=${Date.now()}`);
    const result = await connectPostgres('postgresql://localhost/db');
    expect(result).toHaveProperty('pool');
    expect(result).toHaveProperty('db');
    expect(result).toHaveProperty('healthCheck');
    expect(result).toHaveProperty('getStats');
  });

  test('getStats returns pool statistics', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool-stats=${Date.now()}`);
    const result = await connectPostgres('postgresql://localhost/db');
    const stats = result.getStats();
    expect(stats.totalCount).toBe(5);
    expect(stats.idleCount).toBe(2);
    expect(stats.waitingCount).toBe(1);
  });
});

describe('connectPostgres — connection errors', () => {
  beforeEach(() => {
    poolConstructorOpts = null;
    poolTotalCount = 5;
    poolIdleCount = 2;
    poolWaitingCount = 1;
  });

  test('fails fast when startup SELECT 1 fails', async () => {
    queryFn = async () => {
      throw new Error('connection refused');
    };
    const { connectPostgres } = await import(`../src/connection.ts?pool-fail=${Date.now()}`);
    await expect(connectPostgres('postgresql://localhost/db')).rejects.toThrow(
      'connection refused',
    );
  });

  test('healthCheck returns ok=true when pool responds', async () => {
    queryFn = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
    const { connectPostgres } = await import(`../src/connection.ts?pool-hcok=${Date.now()}`);
    const result = await connectPostgres('postgresql://localhost/db');
    const health = await result.healthCheck();
    expect(health.ok).toBe(true);
  });

  test('healthCheck returns ok=false when query fails', async () => {
    let callCount = 0;
    const origQuery = queryFn;
    queryFn = async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ ok: 1 }], rowCount: 1 };
      throw new Error('disk full');
    };
    const { connectPostgres } = await import(`../src/connection.ts?pool-hcfail=${Date.now()}`);
    const result = await connectPostgres('postgresql://localhost/db');
    const health = await result.healthCheck(5000);
    expect(health.ok).toBe(false);
    expect(health.error).toContain('disk full');
    queryFn = origQuery;
  });

  test('healthCheck respects custom timeout', async () => {
    let callCount = 0;
    queryFn = async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ ok: 1 }], rowCount: 1 };
      return new Promise(() => {});
    };
    const { connectPostgres } = await import(`../src/connection.ts?pool-hcto=${Date.now()}`);
    const result = await connectPostgres('postgresql://localhost/db');
    const health = await result.healthCheck(10);
    expect(health.ok).toBe(false);
    expect(health.error).toContain('readiness check exceeded');
  });
});

describe('pool runtime', () => {
  test('createPostgresPoolRuntime returns runtime with migration mode', () => {
    const runtime = createPostgresPoolRuntime({ migrationMode: 'assume-ready' });
    expect(runtime).toHaveProperty('migrationMode');
    expect(runtime.migrationMode).toBe('assume-ready');
  });

  test('default pool runtime has migration mode "apply"', () => {
    const runtime = createPostgresPoolRuntime();
    expect(runtime.migrationMode).toBe('apply');
  });
});

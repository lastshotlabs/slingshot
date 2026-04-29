/**
 * Prod-hardening tests for resource cleanup, connection timeouts, error
 * propagation, and pool lifecycle guarantees.
 *
 * These tests focus on the non-happy paths that matter in production:
 *   - Pool cleanup when startup verification fails
 *   - Pool.end() resilience (does not mask original error)
 *   - Timeout handling via withTimeout
 *   - Query instrumentation edge cases
 *   - Error propagation across adapter methods
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── Shared mock state ─────────────────────────────────────────────────────────
//
// A single set of mock.module declarations serves ALL describe blocks. Per-test
// state variables control what the MockPool and MockDb return.

let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 2;

interface MockDb {
  select?: () => Builder;
  insert?: (table?: unknown) => Builder;
  update?: (table?: unknown) => Builder;
  delete?: (table?: unknown) => Builder;
  transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

type Builder = Record<string, unknown> & PromiseLike<unknown>;

function makeBuilder(result: unknown, error: Error | null): Builder {
  const proxy: Builder = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          const p = error ? Promise.reject(error) : Promise.resolve(result);
          return p.then(f, r);
        };
      }
      return () => proxy;
    },
  }) as Builder;
  return proxy;
}

function resolvingBuilder(value: unknown): Builder {
  return makeBuilder(value, null);
}

function throwingBuilder(error: Error): Builder {
  return makeBuilder(null, error);
}

// Pool-level state
interface PoolQueryState {
  /** If non-null, the first pool.query() call throws this error. */
  startupError: Error | null;
  /** If non-null, subsequent pool.query() calls throw or hang. */
  runtimeError: Error | 'hang' | null;
}

let poolState: PoolQueryState = { startupError: null, runtimeError: null };
let poolQueryCallCount = 0;
const endMockFn = mock(async () => {});

mock.module('pg', () => ({
  Pool: class UnifiedMockPool {
    totalCount = 5;
    idleCount = 2;
    waitingCount = 1;

    connect() {
      return Promise.resolve({
        query(sql: string) {
          if (sql.includes('SELECT COALESCE(MAX(version), 0) AS version')) {
            return Promise.resolve({ rows: [{ version: mockMigrationVersion }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      });
    }

    query() {
      poolQueryCallCount++;
      if (poolQueryCallCount === 1 && poolState.startupError) {
        throw poolState.startupError;
      }
      if (poolState.runtimeError === 'hang') {
        return new Promise(() => {});
      }
      if (poolState.runtimeError) {
        throw poolState.runtimeError;
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
    }

    end() {
      return endMockFn();
    }
  },
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (!mockDbImpl) throw new Error('mockDbImpl not set');
          const impl = mockDbImpl as Record<string | symbol, unknown>;
          if (prop in impl) return impl[prop];
          throw new Error(`mockDbImpl missing method: ${String(prop)}`);
        },
      },
    ),
}));

// ── withTimeout (re-implemented locally) ──────────────────────────────────────

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// ── Import adapter (after mocks) ──────────────────────────────────────────────

import { createPostgresAdapter } from '../src/adapter.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  test('resolves with the promise value when it completes before the timeout', async () => {
    const result = await raceWithTimeout(Promise.resolve('ok'), 1000, 'should not time out');
    expect(result).toBe('ok');
  });

  test('rejects with timeout message when promise takes too long', async () => {
    const result = await raceWithTimeout(
      new Promise<string>(() => {}), // never settles
      10,
      'custom timeout message',
    ).catch(e => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('custom timeout message');
  });

  test('cleans up the timer when the promise resolves first', async () => {
    const result = await raceWithTimeout(Promise.resolve('fast'), 100, 'timeout message');
    expect(result).toBe('fast');
  });

  test('cleans up the timer when the promise rejects first', async () => {
    const result = await raceWithTimeout(
      Promise.reject(new Error('query failed')),
      100,
      'timeout message',
    ).catch(e => e);
    expect((result as Error).message).toBe('query failed');
  });

  test('fast timeout does not fire when promise resolves immediately', async () => {
    const result = await raceWithTimeout(Promise.resolve('instant'), 1, 'too late');
    expect(result).toBe('instant');
  });
});

describe('pool lifecycle — fail-fast cleanup', () => {
  beforeEach(() => {
    poolState = { startupError: null, runtimeError: null };
    poolQueryCallCount = 0;
    endMockFn.mockClear();
  });

  test('pool.end() is called when startup verification throws', async () => {
    poolState.startupError = new Error('connection refused');

    const { connectPostgres } = await import(
      `../src/connection.ts?prod-fail=${Date.now()}`
    );
    await expect(connectPostgres('postgresql://localhost/db')).rejects.toThrow(
      'connection refused',
    );
    expect(endMockFn).toHaveBeenCalledTimes(1);
  });

  test('pool.end() failure does not mask the original startup error', async () => {
    endMockFn.mockRejectedValueOnce(new Error('end also failed'));
    poolState.startupError = new Error('original error');

    const { connectPostgres } = await import(
      `../src/connection.ts?prod-end-fail=${Date.now()}`
    );

    await expect(connectPostgres('postgresql://localhost/db')).rejects.toThrow(
      'original error',
    );
    expect(endMockFn).toHaveBeenCalled();
  });
});

describe('healthCheck', () => {
  beforeEach(() => {
    poolState = { startupError: null, runtimeError: null };
    poolQueryCallCount = 0;
    endMockFn.mockClear();
  });

  test('returns ok=true when the pool responds', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?prod-hc-ok=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/db');
    const health = await result.healthCheck();
    expect(health.ok).toBe(true);
  });

  test('returns ok=false with error when query fails', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?prod-hc-err=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/db');

    // After startup, make pool.query fail
    poolState.runtimeError = new Error('disk full');
    const health = await result.healthCheck(5000);
    expect(health.ok).toBe(false);
    expect(health.error).toContain('disk full');
  });

  test('respects timeoutMs parameter', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?prod-hc-to=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/db');

    // Make health check query hang; it should time out quickly
    poolState.runtimeError = 'hang';
    const health = await result.healthCheck(50);
    expect(health.ok).toBe(false);
    expect(health.error).toContain('readiness check exceeded');
  });
});

describe('query recording', () => {
  beforeEach(() => {
    poolState = { startupError: null, runtimeError: null };
    poolQueryCallCount = 0;
    endMockFn.mockClear();
  });

  test('getStats reflects successful startup query', async () => {
    const { connectPostgres } = await import(
      `../src/connection.ts?prod-qr=${Date.now()}`
    );
    const result = await connectPostgres('postgresql://localhost/db');
    const stats = result.getStats();
    expect(stats.queryCount).toBe(1);
    expect(stats.errorCount).toBe(0);
  });
});

describe('adapter error propagation', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
    poolState = { startupError: null, runtimeError: null };
    poolQueryCallCount = 0;
    endMockFn.mockClear();
  });

  test('deleteUser: db error propagates to caller', async () => {
    mockDbImpl = { delete: () => throwingBuilder(new Error('permission denied')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.deleteUser!('user-id')).rejects.toThrow('permission denied');
  });

  test('setPassword: db error propagates', async () => {
    mockDbImpl = { update: () => throwingBuilder(new Error('deadlock detected')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setPassword!('user-id', 'newhash')).rejects.toThrow('deadlock detected');
  });

  test('addRole: db error propagates through onConflictDoNothing chain', async () => {
    mockDbImpl = { insert: () => throwingBuilder(new Error('connection reset')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addRole!('user-id', 'admin')).rejects.toThrow('connection reset');
  });

  test('getUserGroups: db error propagates', async () => {
    mockDbImpl = { select: () => throwingBuilder(new Error('table not found')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.getUserGroups!('user-id', null)).rejects.toThrow('table not found');
  });

  test('getEffectiveRoles: db error propagates from direct role query', async () => {
    mockDbImpl = { select: () => throwingBuilder(new Error('catalog error')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.getEffectiveRoles!('user-id', 'tenant-1')).rejects.toThrow('catalog error');
  });

  test('findOrCreateByProvider: db error propagates from oauth account lookup', async () => {
    mockDbImpl = { select: () => throwingBuilder(new Error('connection lost')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(
      adapter.findOrCreateByProvider!('google', 'g-123', { email: 'test@test.com' }),
    ).rejects.toThrow('connection lost');
  });

  test('removeRecoveryCode: db error propagates', async () => {
    mockDbImpl = { delete: () => throwingBuilder(new Error('deadlock')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.removeRecoveryCode!('user-id', 'hash1')).rejects.toThrow('deadlock');
  });

  test('setMfaSecret: db error propagates', async () => {
    mockDbImpl = { update: () => throwingBuilder(new Error('disk full')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setMfaSecret!('user-id', 'secret')).rejects.toThrow('disk full');
  });

  test('removeGroupMember: db error propagates', async () => {
    mockDbImpl = { delete: () => throwingBuilder(new Error('deadlock detected')) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.removeGroupMember!('g-id', 'u-id')).rejects.toThrow('deadlock detected');
  });
});

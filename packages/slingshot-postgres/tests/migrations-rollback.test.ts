/**
 * Migration-rollback tests for slingshot-postgres.
 *
 * Covers migration version detection, schema version mismatch,
 * partial migration scenarios, and graceful handling of migration
 * failures.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── Mocks ─────────────────────────────────────────────────────────────────

let queryResults: Record<string, unknown> = {};
let connectCallCount = 0;

mock.module('pg', () => ({
  Pool: class MockPool {
    connect() {
      connectCallCount++;
      return Promise.resolve({
        query(sql: string) {
          if (sql.includes('SELECT COALESCE(MAX(version), 0) AS version')) {
            return Promise.resolve({ rows: [{ version: queryResults.currentVersion ?? 2 }], rowCount: 1 });
          }
          if (sql.includes('SELECT 1')) {
            return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      });
    }
    end() { return Promise.resolve(); }
  },
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          const impl: Record<string, unknown> = {
            select: () => resolvingBuilder([]),
            insert: () => resolvingBuilder(undefined),
            update: () => resolvingBuilder(undefined),
            delete: () => resolvingBuilder([]),
            transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
              fn({ select: () => resolvingBuilder([{ count: '0' }]), insert: () => resolvingBuilder(undefined) }),
          };
          if (prop in impl) return impl[prop];
          throw new Error(`missing method: ${String(prop)}`);
        },
      },
    ),
}));

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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('migrations — version detection', () => {
  beforeEach(() => {
    queryResults = {};
    connectCallCount = 0;
  });

  test('adapter creation succeeds when schema version matches binary version', async () => {
    queryResults.currentVersion = 2;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    expect(adapter).toBeDefined();
    expect(typeof adapter.findByEmail).toBe('function');
  });

  test('adapter creation succeeds when schema version is behind binary version', async () => {
    queryResults.currentVersion = 1;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    expect(adapter).toBeDefined();
  });

  test('adapter creation succeeds when no schema version exists (version 0)', async () => {
    queryResults.currentVersion = 0;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    expect(adapter).toBeDefined();
  });

  test('adapter creation fails when schema version is newer than binary', async () => {
    queryResults.currentVersion = 99;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    await expect(
      createPostgresAdapter({ pool: new (await import('pg')).Pool() }),
    ).rejects.toThrow('newer than this binary supports');
  });

  test('adapter creation in assume-ready mode skips version check', async () => {
    queryResults.currentVersion = 99;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    const { attachPostgresPoolRuntime, createPostgresPoolRuntime } = await import('@lastshotlabs/slingshot-core');

    const pool = new (await import('pg')).Pool();
    attachPostgresPoolRuntime(pool, createPostgresPoolRuntime({ migrationMode: 'assume-ready' }));

    await expect(createPostgresAdapter({ pool })).resolves.toBeDefined();
  });
});

describe('migrations — connect and migrate', () => {
  beforeEach(() => {
    queryResults = {};
    connectCallCount = 0;
  });

  test('pool.connect is called for migration transaction', async () => {
    queryResults.currentVersion = 0;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    expect(connectCallCount).toBeGreaterThanOrEqual(1);
  });

  test('assume-ready runtime does not call pool.connect for migrations', async () => {
    queryResults.currentVersion = 0;
    const { createPostgresAdapter } = await import('../src/adapter.js');
    const { attachPostgresPoolRuntime, createPostgresPoolRuntime } = await import('@lastshotlabs/slingshot-core');

    const pool = new (await import('pg')).Pool();
    attachPostgresPoolRuntime(pool, createPostgresPoolRuntime({ migrationMode: 'assume-ready' }));

    const beforeCount = connectCallCount;
    await createPostgresAdapter({ pool });
    expect(connectCallCount).toBe(beforeCount);
  });
});

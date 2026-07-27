import { describe, expect, test } from 'bun:test';
import type {
  PostgresBundle,
  StoreInfra,
  TransactionManager,
  TransactionScope,
} from '@lastshotlabs/slingshot-core';
import { createFrameworkTransactionManager } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import { createPostgresTransactionProvider } from '../../src/framework/persistence/transactions/postgresTransactionProvider';

const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');

interface HarnessOptions {
  readonly failBegin?: Error;
  readonly failCommit?: Error;
  readonly failQuery?: Error;
}

function unavailable(store: string): never {
  throw new Error(`${store} is unavailable`);
}

function createHarness(options: HarnessOptions = {}) {
  const queries: string[] = [];
  let checkouts = 0;
  let releases = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql === 'BEGIN' && options.failBegin) throw options.failBegin;
      if (sql === 'COMMIT' && options.failCommit) throw options.failCommit;
      if (sql === 'SELECT broken' && options.failQuery) throw options.failQuery;
      return { rows: [], rowCount: 0 };
    },
    release() {
      releases += 1;
    },
  };
  const pool = {
    async connect() {
      checkouts += 1;
      return client;
    },
    async query() {
      throw new Error('pool.query must not run inside a transaction scope');
    },
  };
  const postgres = { pool, db: {} } as unknown as PostgresBundle;
  let infra: StoreInfra;
  let manager: TransactionManager;
  const frameworkManager = createFrameworkTransactionManager([
    createPostgresTransactionProvider({
      postgres,
      getStoreInfra: () => infra,
    }),
  ]);
  manager = frameworkManager;
  infra = {
    appName: 'postgres-provider-test',
    getTransactions: () => manager,
    getRedis: () => unavailable('Redis'),
    getMongo: () => unavailable('MongoDB'),
    getSqliteDb: () => unavailable('SQLite'),
    getPostgres: () => postgres,
  };
  Object.defineProperty(infra, RESOLVE_TRANSACTION_SCOPE_INFRA, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Reflect.get(frameworkManager, RESOLVE_TRANSACTION_SCOPE_INFRA),
  });

  return {
    client,
    infra,
    manager: frameworkManager,
    queries,
    get checkouts() {
      return checkouts;
    },
    get releases() {
      return releases;
    },
  };
}

function resolveScopeInfra(infra: StoreInfra, scope: TransactionScope): StoreInfra {
  const resolve = Reflect.get(infra, RESOLVE_TRANSACTION_SCOPE_INFRA) as (
    scope: TransactionScope,
  ) => StoreInfra;
  return resolve.call(infra, scope);
}

describe('PostgreSQL framework transaction provider', () => {
  test('uses one checked-out client for scoped queries and same-store nesting', async () => {
    const harness = createHarness();

    await harness.manager.run('postgres', async scope => {
      const scopedInfra = resolveScopeInfra(harness.infra, scope);
      const scopedPool = scopedInfra.getPostgres().pool as unknown as {
        query(sql: string): Promise<unknown>;
        connect?: unknown;
        release?: unknown;
      };
      expect(scopedPool).not.toBe(harness.infra.getPostgres().pool);
      expect(scopedPool.connect).toBeUndefined();
      expect(scopedPool.release).toBeUndefined();
      await scopedPool.query('SELECT 1');

      await harness.manager.run('postgres', async nestedScope => {
        expect(nestedScope).toBe(scope);
        expect(resolveScopeInfra(harness.infra, nestedScope)).toBe(scopedInfra);
        await scopedPool.query('SELECT 2');
      });
    });

    expect(harness.checkouts).toBe(1);
    expect(harness.releases).toBe(1);
    expect(harness.queries).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  });

  test('turns a caught PostgreSQL query failure into rollback-only rejection', async () => {
    const queryError = new Error('duplicate key');
    const harness = createHarness({ failQuery: queryError });

    await expect(
      harness.manager.run('postgres', async scope => {
        const scopedPool = resolveScopeInfra(harness.infra, scope).getPostgres()
          .pool as unknown as {
          query(sql: string): Promise<unknown>;
        };
        try {
          await scopedPool.query('SELECT broken');
        } catch {
          // PostgreSQL has already aborted the physical transaction.
        }
        return 'must-not-commit';
      }),
    ).rejects.toBe(queryError);

    expect(harness.queries).toEqual(['BEGIN', 'SELECT broken', 'ROLLBACK']);
    expect(harness.releases).toBe(1);
  });

  test('releases exactly once when BEGIN fails before a scope is published', async () => {
    const beginError = new Error('begin failed');
    const harness = createHarness({ failBegin: beginError });

    await expect(harness.manager.run('postgres', async () => undefined)).rejects.toBe(beginError);
    expect(harness.queries).toEqual(['BEGIN']);
    expect(harness.checkouts).toBe(1);
    expect(harness.releases).toBe(1);
  });

  test('rolls back and releases exactly once after COMMIT fails', async () => {
    const harness = createHarness({ failCommit: new Error('commit failed') });

    await expect(harness.manager.run('postgres', async () => 'value')).rejects.toMatchObject({
      code: 'TRANSACTION_COMMIT_FAILED',
      outcome: 'rolled_back',
    });
    expect(harness.queries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(harness.releases).toBe(1);
  });
});

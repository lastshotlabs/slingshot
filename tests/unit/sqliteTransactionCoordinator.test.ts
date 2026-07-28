import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { EntityAdapter, StoreInfra, TransactionScope } from '@lastshotlabs/slingshot-core';
import { TransactionScopeMismatchError } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, defineEntity, field } from '@lastshotlabs/slingshot-entity';
import { createFrameworkTransactionManager } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import {
  RUN_SQLITE_ENTITY_OPERATION,
  SqliteCoordinatorClosedError,
  createSqliteTransactionCoordinator,
  createSqliteTransactionProvider,
} from '../../src/framework/persistence/transactions/sqliteTransactionCoordinator';

const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function unavailable(store: string): never {
  throw new Error(`${store} is unavailable`);
}

function createHarness(db: Database) {
  const coordinator = createSqliteTransactionCoordinator();
  let infra: StoreInfra;
  const manager = createFrameworkTransactionManager([
    createSqliteTransactionProvider({
      db,
      coordinator,
      getStoreInfra: () => infra,
    }),
  ]);
  infra = {
    appName: 'sqlite-transaction-test',
    getTransactions: () => manager,
    getRedis: () => unavailable('Redis'),
    getMongo: () => unavailable('MongoDB'),
    getSqliteDb: () => db,
    getPostgres: () => unavailable('PostgreSQL'),
  };
  Object.defineProperties(infra, {
    [RUN_SQLITE_ENTITY_OPERATION]: {
      value: <T>(operation: () => T | Promise<T>) => coordinator.run(operation),
    },
    [RESOLVE_TRANSACTION_SCOPE_INFRA]: {
      value: Reflect.get(manager, RESOLVE_TRANSACTION_SCOPE_INFRA),
    },
  });
  return { coordinator, infra, manager };
}

const AccountEntity = defineEntity('PhaseFiveAccount', {
  namespace: 'phase_five',
  fields: {
    id: field.string({ primary: true }),
    value: field.string(),
  },
});

const LedgerEntity = defineEntity('PhaseFiveLedger', {
  namespace: 'phase_five',
  fields: {
    id: field.string({ primary: true }),
    accountId: field.string(),
  },
});

type TestAdapter = EntityAdapter<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;

function registerEntity(
  harness: ReturnType<typeof createHarness>,
  plugin: string,
  entity: string,
  factories: ReturnType<typeof createEntityFactories>,
): void {
  harness.manager.registerEntity({
    plugin,
    entity,
    store: 'sqlite',
    buildAdapter: infra => factories.sqlite(infra),
  });
}

function scopedAdapter(
  harness: ReturnType<typeof createHarness>,
  entity: string,
  scope: TransactionScope,
): TestAdapter {
  return harness.manager.resolveEntity({
    plugin: 'phase-five',
    entity,
    scope,
  }) as TestAdapter;
}

describe('SQLite transaction coordinator', () => {
  test('grants unrelated operations in FIFO order', async () => {
    const coordinator = createSqliteTransactionCoordinator();
    const firstGate = deferred();
    const order: string[] = [];

    const first = coordinator.run(async () => {
      order.push('first:start');
      await firstGate.promise;
      order.push('first:end');
    });
    const second = coordinator.run(() => {
      order.push('second');
    });
    const third = coordinator.run(() => {
      order.push('third');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  test('rejects queued and future operations during shutdown without leaking waiters', async () => {
    const coordinator = createSqliteTransactionCoordinator();
    const activeGate = deferred();
    const active = coordinator.run(() => activeGate.promise);
    const queued = coordinator.run(() => undefined);

    coordinator.shutdown();
    await expect(queued).rejects.toBeInstanceOf(SqliteCoordinatorClosedError);
    await expect(coordinator.run(() => undefined)).rejects.toBeInstanceOf(
      SqliteCoordinatorClosedError,
    );

    activeGate.resolve();
    await active;
  });

  test('uses BEGIN IMMEDIATE, reuses same-store scope, and rejects cross-store nesting', async () => {
    const statements: string[] = [];
    const db = new Database(':memory:');
    const originalRun = db.run.bind(db);
    db.run = ((sql: string, ...params: unknown[]) => {
      statements.push(sql);
      return Reflect.apply(originalRun, db, [sql, ...params]) as ReturnType<typeof db.run>;
    }) as typeof db.run;
    const harness = createHarness(db);
    try {
      await harness.manager.run('sqlite', async scope => {
        await harness.manager.run('sqlite', nested => {
          expect(nested).toBe(scope);
        });
        await expect(harness.manager.run('postgres', async () => undefined)).rejects.toBeInstanceOf(
          TransactionScopeMismatchError,
        );
      });
      expect(statements).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    } finally {
      db.close();
    }
  });

  test('keeps an unrelated adapter write outside a rolled-back transaction', async () => {
    const db = new Database(':memory:');
    const harness = createHarness(db);
    const factories = createEntityFactories(AccountEntity);
    registerEntity(harness, 'phase-five', 'Account', factories);
    const outside = factories.sqlite(harness.infra) as TestAdapter;
    const releaseTransaction = deferred();
    let outsideSettled = false;

    try {
      await outside.create({ id: 'a1', value: 'initial' });
      const transaction = harness.manager.run('sqlite', async scope => {
        const account = scopedAdapter(harness, 'Account', scope);
        await account.update('a1', { value: 'inside' });
        await releaseTransaction.promise;
        throw new Error('rollback');
      });

      await Promise.resolve();
      const outsideWrite = outside.update('a1', { value: 'outside' }).then(value => {
        outsideSettled = true;
        return value;
      });
      await Promise.resolve();
      expect(outsideSettled).toBe(false);

      releaseTransaction.resolve();
      await expect(transaction).rejects.toThrow('rollback');
      await outsideWrite;
      expect(await outside.getById('a1')).toMatchObject({ value: 'outside' });
    } finally {
      db.close();
    }
  });

  test('releases a queued adapter operation after commit', async () => {
    const db = new Database(':memory:');
    const harness = createHarness(db);
    const factories = createEntityFactories(AccountEntity);
    registerEntity(harness, 'phase-five', 'Account', factories);
    const outside = factories.sqlite(harness.infra) as TestAdapter;
    const releaseTransaction = deferred();
    let outsideSettled = false;

    try {
      await outside.create({ id: 'a1', value: 'initial' });
      const transaction = harness.manager.run('sqlite', async scope => {
        await scopedAdapter(harness, 'Account', scope).update('a1', { value: 'committed' });
        await releaseTransaction.promise;
      });

      await Promise.resolve();
      const outsideWrite = outside.update('a1', { value: 'after-commit' }).then(value => {
        outsideSettled = true;
        return value;
      });
      await Promise.resolve();
      expect(outsideSettled).toBe(false);

      releaseTransaction.resolve();
      await transaction;
      await outsideWrite;
      expect(await outside.getById('a1')).toMatchObject({ value: 'after-commit' });
    } finally {
      db.close();
    }
  });

  test('releases the coordinator lease when BEGIN IMMEDIATE fails', async () => {
    const db = new Database(':memory:');
    const harness = createHarness(db);
    try {
      db.run('BEGIN');
      await expect(harness.manager.run('sqlite', async () => undefined)).rejects.toThrow(
        'cannot start a transaction within a transaction',
      );
      db.run('ROLLBACK');

      await expect(harness.coordinator.run(() => 'available')).resolves.toBe('available');
    } finally {
      db.close();
    }
  });

  test('rolls back identical two-entity package-service work in a temporary-file database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'slingshot-sqlite-phase5-'));
    tempDirs.push(directory);
    const db = new Database(join(directory, 'app.sqlite'));
    const harness = createHarness(db);
    const accountFactories = createEntityFactories(AccountEntity);
    const ledgerFactories = createEntityFactories(LedgerEntity);
    registerEntity(harness, 'phase-five', 'Account', accountFactories);
    registerEntity(harness, 'phase-five', 'Ledger', ledgerFactories);
    const accounts = accountFactories.sqlite(harness.infra) as TestAdapter;
    const ledgers = ledgerFactories.sqlite(harness.infra) as TestAdapter;

    try {
      await expect(
        harness.manager.run('sqlite', async scope => {
          await scopedAdapter(harness, 'Account', scope).create({
            id: 'a1',
            value: 'created',
          });
          await scopedAdapter(harness, 'Ledger', scope).create({
            id: 'l1',
            accountId: 'a1',
          });
          throw new Error('package service failed');
        }),
      ).rejects.toThrow('package service failed');

      expect(await accounts.getById('a1')).toBeNull();
      expect(await ledgers.getById('l1')).toBeNull();
    } finally {
      db.close();
    }
  });
});

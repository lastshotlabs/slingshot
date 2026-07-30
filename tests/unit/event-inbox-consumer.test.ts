import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type {
  EventEnvelope,
  SlingshotEventBus,
  StoreInfra,
  TransactionScope,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionScopeClosedError,
  createEventEnvelope,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventStoreMismatchError,
  createTransactionalEventConsumer,
  initializeEventReliabilityStore,
} from '@lastshotlabs/slingshot-events';
import { createFrameworkTransactionManager } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import {
  createSqliteTransactionCoordinator,
  createSqliteTransactionProvider,
} from '../../src/framework/persistence/transactions/sqliteTransactionCoordinator';

const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function harness() {
  const db = new Database(':memory:');
  databases.push(db);
  const coordinator = createSqliteTransactionCoordinator();
  let infra: StoreInfra;
  const transactions = createFrameworkTransactionManager([
    createSqliteTransactionProvider({ db, coordinator, getStoreInfra: () => infra }),
  ]);
  infra = {
    appName: 'inbox-test',
    getTransactions: () => transactions,
    getSqliteDb: () => db,
    getPostgres: () => {
      throw new Error('not configured');
    },
    getMongo: () => {
      throw new Error('not configured');
    },
    getRedis: () => {
      throw new Error('not configured');
    },
  };
  await initializeEventReliabilityStore(infra, {
    store: 'sqlite',
    inbox: { enabled: true },
  });
  db.run('CREATE TABLE projections (id TEXT PRIMARY KEY, executions INTEGER NOT NULL)');
  const bus = createInProcessAdapter();
  const resolveInfra = Reflect.get(transactions, RESOLVE_TRANSACTION_SCOPE_INFRA) as (
    scope: TransactionScope,
  ) => StoreInfra;
  const consumer = createTransactionalEventConsumer('sqlite', bus, transactions, scope =>
    resolveInfra.call(transactions, scope),
  );
  return { db, bus, consumer, resolveInfra, transactions };
}

function envelope(): EventEnvelope<'app:ready'> {
  return createEventEnvelope({
    key: 'app:ready',
    payload: { plugins: ['orders'] },
    ownerPlugin: 'test',
    exposure: ['internal'],
    scope: null,
    requestTenantId: null,
  });
}

function deliver(bus: SlingshotEventBus, value: EventEnvelope<'app:ready'>): void {
  (bus as unknown as { emit(key: string, payload: unknown): void }).emit(value.key, value);
}

async function drain(bus: SlingshotEventBus): Promise<void> {
  await (bus as SlingshotEventBus & { drain(): Promise<void> }).drain();
}

describe('transactional event inbox consumer', () => {
  test('commits one receipt and SQL effect, then skips duplicate delivery', async () => {
    const { db, bus, consumer } = await harness();
    let executions = 0;
    consumer.consume(
      'app:ready',
      (_event, { scope }) => {
        executions++;
        expect(scope.store).toBe('sqlite');
        db.run('INSERT INTO projections (id, executions) VALUES (?, ?)', ['orders', executions]);
      },
      { durable: true, name: 'orders-v1', inbox: { store: 'sqlite' } },
    );
    const event = envelope();

    deliver(bus, event);
    await drain(bus);
    deliver(bus, event);
    await drain(bus);

    expect(executions).toBe(1);
    expect(db.query('SELECT * FROM projections').all()).toHaveLength(1);
    expect(db.query('SELECT * FROM slingshot_event_inbox').all()).toHaveLength(1);
  });

  test('rolls back receipt and effects after handler failure, then succeeds on retry', async () => {
    const { db, bus, consumer } = await harness();
    let attempts = 0;
    consumer.consume(
      'app:ready',
      () => {
        attempts++;
        db.run('INSERT INTO projections (id, executions) VALUES (?, ?)', ['retry', attempts]);
        if (attempts === 1) throw new Error('retry me');
      },
      { durable: true, name: 'retry-v1', inbox: { store: 'sqlite' } },
    );
    const event = envelope();

    deliver(bus, event);
    await drain(bus);
    expect(db.query('SELECT * FROM projections').all()).toHaveLength(0);
    expect(db.query('SELECT * FROM slingshot_event_inbox').all()).toHaveLength(0);

    deliver(bus, event);
    await drain(bus);
    expect(attempts).toBe(2);
    expect(db.query('SELECT * FROM projections').all()).toHaveLength(1);
    expect(db.query('SELECT * FROM slingshot_event_inbox').all()).toHaveLength(1);
  });

  test('serializes concurrent duplicate deliveries to one committed execution', async () => {
    const { db, bus, consumer } = await harness();
    let executions = 0;
    consumer.consume(
      'app:ready',
      async () => {
        executions++;
        await Promise.resolve();
        db.run('INSERT INTO projections (id, executions) VALUES (?, ?)', ['race', executions]);
      },
      { durable: true, name: 'race-v1', inbox: { store: 'sqlite' } },
    );
    const event = envelope();

    deliver(bus, event);
    deliver(bus, event);
    await drain(bus);

    expect(executions).toBe(1);
    expect(db.query('SELECT * FROM slingshot_event_inbox').all()).toHaveLength(1);
  });

  test('consumer names are independent identities and retained scopes close', async () => {
    const { bus, consumer, resolveInfra } = await harness();
    let retained: TransactionScope | undefined;
    let executions = 0;
    for (const name of ['projection-v1', 'projection-v2']) {
      consumer.consume(
        'app:ready',
        (_event, context) => {
          executions++;
          retained = context.scope;
        },
        { durable: true, name, inbox: { store: 'sqlite' } },
      );
    }
    deliver(bus, envelope());
    await drain(bus);
    expect(executions).toBe(2);

    const scope = retained as TransactionScope;
    expect(() => resolveInfra.call(null, scope)).toThrow(TransactionScopeClosedError);
  });

  test('a restarted named consumer skips an already committed delivery', async () => {
    const { db, bus, consumer, resolveInfra, transactions } = await harness();
    const event = envelope();
    let executions = 0;
    const options = {
      durable: true as const,
      name: 'restart-proof-v1',
      inbox: { store: 'sqlite' as const },
    };
    consumer.consume(
      'app:ready',
      () => {
        executions++;
      },
      options,
    );
    deliver(bus, event);
    await drain(bus);

    const restarted = createTransactionalEventConsumer('sqlite', bus, transactions, scope =>
      resolveInfra.call(null, scope),
    );
    restarted.consume(
      'app:ready',
      () => {
        executions++;
      },
      options,
    );
    deliver(bus, event);
    await drain(bus);

    expect(db.query('SELECT * FROM slingshot_event_inbox').all()).toHaveLength(1);
    expect(executions).toBe(1);
  });

  test('rejects a configured-store mismatch before subscription', async () => {
    const { consumer } = await harness();
    expect(() =>
      consumer.consume('app:ready', () => {}, {
        durable: true,
        name: 'wrong-store',
        inbox: { store: 'postgres' },
      }),
    ).toThrow(TransactionalEventStoreMismatchError);
  });
});

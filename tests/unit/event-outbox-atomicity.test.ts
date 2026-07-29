import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type StoreInfra,
  type TransactionScope,
  TransactionScopeClosedError,
  TransactionScopeInvalidError,
  createEventDefinitionRegistry,
  createEventEnvelope,
  createEventPublisher,
  createEventSchemaRegistry,
  createInProcessAdapter,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventScopeRequiredError,
  TransactionalEventStoreMismatchError,
  createTransactionalEventOutboxWriter,
  initializeEventReliabilityStore,
} from '@lastshotlabs/slingshot-events';
import { ENQUEUE_TRANSACTION_SCOPE_WORK } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import { createFrameworkTransactionManager } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import {
  createSqliteTransactionCoordinator,
  createSqliteTransactionProvider,
} from '../../src/framework/persistence/transactions/sqliteTransactionCoordinator';

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function createHarness() {
  const db = new Database(':memory:');
  databases.push(db);
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
    appName: 'outbox-test',
    getTransactions: () => manager,
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
    outbox: { enabled: true },
  });
  db.run('CREATE TABLE domain_writes (id TEXT PRIMARY KEY)');

  const enqueue = Reflect.get(manager, ENQUEUE_TRANSACTION_SCOPE_WORK) as (
    scope: TransactionScope,
    work: (scopedInfra: StoreInfra) => void | Promise<void>,
  ) => void;
  const writer = createTransactionalEventOutboxWriter('sqlite', (scope, work) =>
    enqueue.call(manager, scope, work),
  );
  const definitions = createEventDefinitionRegistry({
    schemaRegistry: createEventSchemaRegistry(),
  });
  definitions.register(
    defineEvent('app:ready', {
      ownerPlugin: 'test',
      exposure: ['internal'],
      resolveScope: () => null,
    }),
  );
  const events = createEventPublisher({
    definitions,
    bus: createInProcessAdapter(),
    outbox: writer,
  });
  return { db, manager, writer, events, enqueue };
}

describe('transactional event outbox insertion', () => {
  test('commits domain work and its outbox row together', async () => {
    const { db, manager, events, enqueue } = await createHarness();
    await manager.run('sqlite', async scope => {
      enqueue.call(manager, scope, scoped => {
        scoped.getSqliteDb().run('INSERT INTO domain_writes (id) VALUES (?)', 'committed');
      });
      events.publish(
        'app:ready',
        { plugins: ['orders'] },
        { requestTenantId: null, delivery: 'outbox', transaction: scope },
      );
    });

    expect(db.query('SELECT id FROM domain_writes').all()).toHaveLength(1);
    const rows = db
      .query<
        {
          event_id: string;
          status: string;
        },
        []
      >('SELECT event_id, status FROM slingshot_event_outbox')
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });

  test('rolls back both domain work and outbox insertion', async () => {
    const { db, manager, events, enqueue } = await createHarness();
    await expect(
      manager.run('sqlite', async scope => {
        enqueue.call(manager, scope, scoped => {
          scoped.getSqliteDb().run('INSERT INTO domain_writes (id) VALUES (?)', 'rolled-back');
        });
        events.publish(
          'app:ready',
          { plugins: [] },
          { requestTenantId: null, delivery: 'outbox', transaction: scope },
        );
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(db.query('SELECT id FROM domain_writes').all()).toHaveLength(0);
    expect(db.query('SELECT event_id FROM slingshot_event_outbox').all()).toHaveLength(0);
  });

  test('rejects missing, mismatched, closed, and forged scopes before SQL', async () => {
    const { db, manager, writer, events } = await createHarness();
    expect(() =>
      events.publish('app:ready', { plugins: [] }, { requestTenantId: null, delivery: 'outbox' }),
    ).toThrow(TransactionalEventScopeRequiredError);

    let retainedScope: TransactionScope | undefined;
    await manager.run('sqlite', scope => {
      retainedScope = scope;
      const postgresWriter = createTransactionalEventOutboxWriter('postgres', () => {});
      expect(() =>
        postgresWriter.write(
          createEventEnvelope({
            key: 'app:ready',
            payload: { plugins: [] },
            ownerPlugin: 'test',
            exposure: ['internal'],
            scope: null,
            requestTenantId: null,
          }),
          scope,
        ),
      ).toThrow(TransactionalEventStoreMismatchError);
    });
    expect(retainedScope).toBeDefined();
    const closedScope = retainedScope as TransactionScope;

    expect(() =>
      writer.write(
        createEventEnvelope({
          key: 'app:ready',
          payload: { plugins: [] },
          ownerPlugin: 'test',
          exposure: ['internal'],
          scope: null,
          requestTenantId: null,
        }),
        closedScope,
      ),
    ).toThrow(TransactionScopeClosedError);
    expect(db.query('SELECT event_id FROM slingshot_event_outbox').all()).toHaveLength(0);

    expect(() =>
      writer.write(
        createEventEnvelope({
          key: 'app:ready',
          payload: { plugins: [] },
          ownerPlugin: 'test',
          exposure: ['internal'],
          scope: null,
          requestTenantId: null,
        }),
        Object.freeze({ store: 'sqlite', id: 'forged' }) as TransactionScope,
      ),
    ).toThrow(TransactionScopeInvalidError);
  });

  test('nested same-store transactions reuse the scope and preserve event order', async () => {
    const { db, manager, events } = await createHarness();
    await manager.run('sqlite', async outer => {
      await manager.run('sqlite', inner => {
        expect(inner).toBe(outer);
        events.publish(
          'app:ready',
          { plugins: ['first'] },
          { requestTenantId: null, delivery: 'outbox', transaction: inner },
        );
      });
      events.publish(
        'app:ready',
        { plugins: ['second'] },
        { requestTenantId: null, delivery: 'outbox', transaction: outer },
      );
    });

    const rows = db
      .query<
        {
          envelope_json: string;
        },
        []
      >('SELECT envelope_json FROM slingshot_event_outbox ORDER BY created_at, rowid')
      .all();
    expect(rows.map(row => JSON.parse(row.envelope_json).payload.plugins[0])).toEqual([
      'first',
      'second',
    ]);
  });

  test('duplicate event IDs cannot create two outbox rows', async () => {
    const { db, manager, writer } = await createHarness();
    const envelope = createEventEnvelope({
      key: 'app:ready',
      payload: { plugins: [] },
      ownerPlugin: 'test',
      exposure: ['internal'],
      scope: null,
      requestTenantId: null,
    });

    await expect(
      manager.run('sqlite', scope => {
        writer.write(envelope, scope);
        writer.write(envelope, scope);
      }),
    ).rejects.toThrow();
    expect(db.query('SELECT event_id FROM slingshot_event_outbox').all()).toHaveLength(0);
  });
});

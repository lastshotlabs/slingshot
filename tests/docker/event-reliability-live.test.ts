import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createBullMQAdapter } from '@lastshotlabs/slingshot-bullmq';
import type {
  EventEnvelope,
  PostgresBundle,
  RuntimeSqliteDatabase,
  StoreInfra,
  TransactionScope,
} from '@lastshotlabs/slingshot-core';
import {
  createInProcessAdapter,
  createRawEventEnvelope,
  createUnsupportedTransactionManager,
} from '@lastshotlabs/slingshot-core';
import {
  createOutboxDispatcher,
  createPostgresOutboxDispatchRepository,
  createPostgresOutboxRepository,
  createSqliteOutboxDispatchRepository,
  createSqliteOutboxRepository,
  createTransactionalEventConsumer,
  initializeEventReliabilityStore,
  serializeOutboxEnvelope,
} from '@lastshotlabs/slingshot-events';
import { createKafkaAdapter } from '@lastshotlabs/slingshot-kafka';
import { createFrameworkTransactionManager } from '../../src/framework/persistence/transactions/frameworkTransactionManager';
import { createPostgresTransactionProvider } from '../../src/framework/persistence/transactions/postgresTransactionProvider';

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';
const REDIS = { host: 'localhost', port: 6380 };
const KAFKA = 'localhost:19092';

describe('transactional event reliability live matrix', () => {
  const schema = `event_reliability_${randomUUID().replaceAll('-', '_')}`;
  const admin = new Pool({ connectionString: POSTGRES_URL });
  let pool: Pool;
  let postgres: PostgresBundle;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(POSTGRES_URL);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = new Pool({ connectionString: scoped.toString() });
    postgres = { pool } as unknown as PostgresBundle;
    const infra: StoreInfra = {
      appName: 'event-reliability-live',
      getTransactions: createUnsupportedTransactionManager,
      getPostgres: () => postgres,
      getSqliteDb: () => {
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
      store: 'postgres',
      outbox: { enabled: true },
    });
    await pool.query(
      'CREATE TABLE inbox_projection (id TEXT PRIMARY KEY, executions INTEGER NOT NULL)',
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  async function postgresStatus(eventId: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM slingshot_event_outbox WHERE event_id = $1',
      [eventId],
    );
    return result.rows[0]?.status;
  }

  test('PostgreSQL + BullMQ acknowledges delivery three consecutive times', async () => {
    const bus = createBullMQAdapter({
      connection: REDIS,
      prefix: `wp4-live-${randomUUID()}`,
    });
    bus.on('app:ready', () => {}, { durable: true, name: 'wp4-live-consumer' });
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        const envelope = createRawEventEnvelope('app:ready', {
          plugins: [`bullmq-${iteration}`],
        });
        await createPostgresOutboxRepository(postgres).insert(serializeOutboxEnvelope(envelope));
        const dispatcher = createOutboxDispatcher({
          repository: createPostgresOutboxDispatchRepository(postgres),
          bus,
          config: { enabled: true },
        });
        expect(await dispatcher.dispatchOnce()).toBeGreaterThan(0);
        expect(await postgresStatus(envelope.meta.eventId)).toBe('delivered');
        await dispatcher.shutdown();
      }
    } finally {
      await bus.shutdown?.();
    }
  }, 30_000);

  test('PostgreSQL + Kafka acknowledges delivery three consecutive times', async () => {
    const bus = createKafkaAdapter({
      brokers: [KAFKA],
      topicPrefix: `wp4.live.${randomUUID()}`,
    });
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        const envelope = createRawEventEnvelope('app:ready', {
          plugins: [`kafka-${iteration}`],
        });
        await createPostgresOutboxRepository(postgres).insert(serializeOutboxEnvelope(envelope));
        const dispatcher = createOutboxDispatcher({
          repository: createPostgresOutboxDispatchRepository(postgres),
          bus,
          config: { enabled: true },
        });
        expect(await dispatcher.dispatchOnce()).toBeGreaterThan(0);
        expect(await postgresStatus(envelope.meta.eventId)).toBe('delivered');
        await dispatcher.shutdown();
      }
    } finally {
      await bus.shutdown?.();
    }
  }, 30_000);

  test('SQLite + BullMQ acknowledges delivery three consecutive times', async () => {
    const db = new Database(':memory:');
    const runtimeDb = db as unknown as RuntimeSqliteDatabase;
    const infra: StoreInfra = {
      appName: 'event-reliability-sqlite-live',
      getTransactions: createUnsupportedTransactionManager,
      getSqliteDb: () => runtimeDb,
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
    const bus = createBullMQAdapter({
      connection: REDIS,
      prefix: `wp4-sqlite-live-${randomUUID()}`,
    });
    bus.on('app:ready', () => {}, { durable: true, name: 'wp4-sqlite-consumer' });
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        const envelope: EventEnvelope<'app:ready'> = createRawEventEnvelope('app:ready', {
          plugins: [`sqlite-bullmq-${iteration}`],
        });
        createSqliteOutboxRepository(runtimeDb).insert(serializeOutboxEnvelope(envelope));
        const dispatcher = createOutboxDispatcher({
          repository: createSqliteOutboxDispatchRepository(runtimeDb),
          bus,
          config: { enabled: true },
        });
        expect(await dispatcher.dispatchOnce()).toBeGreaterThan(0);
        const row = db
          .query('SELECT status FROM slingshot_event_outbox WHERE event_id = ?')
          .get(envelope.meta.eventId) as { status: string } | null;
        expect(row?.status).toBe('delivered');
        await dispatcher.shutdown();
      }
    } finally {
      await bus.shutdown?.();
      db.close();
    }
  }, 30_000);

  test('PostgreSQL inbox commits one concurrent duplicate and retries rollback', async () => {
    const bus = createInProcessAdapter();
    let infra: StoreInfra;
    const transactions = createFrameworkTransactionManager([
      createPostgresTransactionProvider({
        postgres,
        getStoreInfra: () => infra,
      }),
    ]);
    infra = {
      appName: 'event-inbox-live',
      getTransactions: () => transactions,
      getPostgres: () => postgres,
      getSqliteDb: () => {
        throw new Error('not configured');
      },
      getMongo: () => {
        throw new Error('not configured');
      },
      getRedis: () => {
        throw new Error('not configured');
      },
    };
    const resolve = Reflect.get(
      transactions,
      Symbol.for('slingshot.resolveTransactionScopeInfra'),
    ) as (scope: TransactionScope) => StoreInfra;
    const consumer = createTransactionalEventConsumer('postgres', bus, transactions, scope =>
      resolve.call(transactions, scope),
    );
    const dynamicBus = bus as unknown as { emit(key: string, payload: unknown): void };
    const drain = () => (bus as typeof bus & { drain(): Promise<void> }).drain();

    let raceExecutions = 0;
    consumer.consume(
      'app:ready',
      async (_envelope, { scope }) => {
        raceExecutions++;
        await resolve
          .call(transactions, scope)
          .getPostgres()
          .pool.query('INSERT INTO inbox_projection (id, executions) VALUES ($1, $2)', [
            'race',
            raceExecutions,
          ]);
      },
      { durable: true, name: 'postgres-race-v1', inbox: { store: 'postgres' } },
    );
    const raceEnvelope = createRawEventEnvelope('app:ready', { plugins: ['race'] });
    dynamicBus.emit(raceEnvelope.key, raceEnvelope);
    dynamicBus.emit(raceEnvelope.key, raceEnvelope);
    await drain();
    expect(raceExecutions).toBe(1);

    let retryAttempts = 0;
    consumer.consume(
      'app:shutdown',
      async (_envelope, { scope }) => {
        retryAttempts++;
        await resolve
          .call(transactions, scope)
          .getPostgres()
          .pool.query('INSERT INTO inbox_projection (id, executions) VALUES ($1, $2)', [
            'retry',
            retryAttempts,
          ]);
        if (retryAttempts === 1) throw new Error('retry postgres inbox');
      },
      { durable: true, name: 'postgres-retry-v1', inbox: { store: 'postgres' } },
    );
    const retryEnvelope = createRawEventEnvelope('app:shutdown', { signal: 'SIGTERM' });
    dynamicBus.emit(retryEnvelope.key, retryEnvelope);
    await drain();
    dynamicBus.emit(retryEnvelope.key, retryEnvelope);
    await drain();

    expect(retryAttempts).toBe(2);
    const rows = await pool.query<{ id: string }>('SELECT id FROM inbox_projection ORDER BY id');
    expect(rows.rows.map(row => row.id)).toEqual(['race', 'retry']);
    await bus.shutdown?.();
  });
});

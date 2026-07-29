import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { EventEnvelope, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createOutboxDispatcher,
  createSqliteOutboxDispatchRepository,
  createSqliteOutboxRepository,
} from '../src';
import { SQLITE_EVENT_RELIABILITY_MIGRATIONS } from '../src/migrations/sqlite';
import { serializeOutboxEnvelope } from '../src/outbox/repository';

function database(): Database {
  const db = new Database(':memory:');
  for (const migration of SQLITE_EVENT_RELIABILITY_MIGRATIONS) {
    for (const statement of migration.statements) db.run(statement);
  }
  return db;
}

describe('SQLite outbox dispatch repository', () => {
  test('claims, acknowledges, and finalizes a stable envelope', async () => {
    const db = database();
    try {
      const runtimeDb = db as unknown as RuntimeSqliteDatabase;
      const envelope = createRawEventEnvelope('app:shutdown', { signal: 'SIGTERM' });
      createSqliteOutboxRepository(runtimeDb).insert(serializeOutboxEnvelope(envelope));
      const dispatchRepository = createSqliteOutboxDispatchRepository(runtimeDb);
      const dispatcher = createOutboxDispatcher({
        repository: dispatchRepository,
        bus: Object.assign(createInProcessAdapter(), {
          async publishEnvelope(received: EventEnvelope) {
            return {
              eventId: received.meta.eventId,
              acceptedAt: new Date().toISOString(),
              transport: 'bullmq' as const,
              durableDestinations: 1,
            };
          },
        }),
        owner: 'sqlite-worker',
        config: { enabled: true },
      });

      expect(await dispatcher.dispatchOnce()).toBe(1);
      const row = db.query('SELECT status FROM slingshot_event_outbox').get() as {
        status: string;
      } | null;
      expect(row?.status).toBe('delivered');
    } finally {
      db.close();
    }
  });

  test('recovers an expired lease under a different owner', async () => {
    const db = database();
    try {
      const runtimeDb = db as unknown as RuntimeSqliteDatabase;
      const envelope = createRawEventEnvelope('app:shutdown', { signal: 'SIGTERM' });
      createSqliteOutboxRepository(runtimeDb).insert(serializeOutboxEnvelope(envelope));
      const repository = createSqliteOutboxDispatchRepository(runtimeDb);
      const first = await repository.claim({
        owner: 'crashed-worker',
        limit: 1,
        now: '2099-07-29T00:00:00.000Z',
        leaseExpiresAt: '2099-07-29T00:00:01.000Z',
      });
      const second = await repository.claim({
        owner: 'recovery-worker',
        limit: 1,
        now: '2099-07-29T00:00:02.000Z',
        leaseExpiresAt: '2099-07-29T00:00:03.000Z',
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      const row = db
        .query('SELECT lease_owner FROM slingshot_event_outbox WHERE id = ?')
        .get(first[0]?.id) as { lease_owner: string } | null;
      expect(row?.lease_owner).toBe('recovery-worker');
    } finally {
      db.close();
    }
  });
});

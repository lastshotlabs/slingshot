import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createSqliteEventReliabilityOperations } from '../src';
import { SQLITE_EVENT_RELIABILITY_MIGRATIONS } from '../src/migrations/sqlite';

function database(): Database {
  const db = new Database(':memory:');
  for (const migration of SQLITE_EVENT_RELIABILITY_MIGRATIONS) {
    for (const statement of migration.statements) db.run(statement);
  }
  return db;
}

function insertOutbox(
  db: Database,
  input: {
    id: string;
    status: 'pending' | 'leased' | 'delivered' | 'dead';
    createdAt: string;
    deliveredAt?: string;
    leaseExpiresAt?: string;
  },
): void {
  db.run(
    `INSERT INTO slingshot_event_outbox (
      id, event_id, event_key, envelope_json, status, attempts, available_at,
      lease_owner, lease_expires_at, created_at, delivered_at
    ) VALUES (?, ?, 'app:ready', ?, ?, 3, ?, ?, ?, ?, ?)`,
    [
      input.id,
      `event-${input.id}`,
      JSON.stringify({ stable: input.id }),
      input.status,
      input.createdAt,
      input.status === 'leased' ? 'worker' : null,
      input.leaseExpiresAt ?? null,
      input.createdAt,
      input.deliveredAt ?? null,
    ],
  );
}

describe('SQLite event reliability operations', () => {
  test('reports bounded status and lists without envelope payloads', async () => {
    const db = database();
    try {
      insertOutbox(db, { id: 'pending', status: 'pending', createdAt: '2026-01-01T00:00:00Z' });
      insertOutbox(db, {
        id: 'leased',
        status: 'leased',
        createdAt: '2026-01-02T00:00:00Z',
        leaseExpiresAt: '2026-01-02T00:00:01Z',
      });
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );
      const status = await operations.status('2026-01-03T00:00:00Z');
      const rows = await operations.list('pending', 10);

      expect(status.counts).toEqual({ pending: 1, leased: 1, delivered: 0, dead: 0 });
      expect(status.oldestPendingAt).toBe('2026-01-01T00:00:00Z');
      expect(status.expiredLeases).toBe(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('envelopeJson');
    } finally {
      db.close();
    }
  });

  test('inspects one event through a bounded recursively redacted projection', async () => {
    const db = database();
    try {
      insertOutbox(db, { id: 'detail', status: 'dead', createdAt: '2026-01-01T00:00:00Z' });
      db.run(
        `UPDATE slingshot_event_outbox
            SET envelope_json = ?, last_error_message = ?
          WHERE event_id = 'event-detail'`,
        [
          JSON.stringify({
            key: 'orders:created',
            payload: {
              orderId: 'order-1',
              password: 'do-not-show',
              nested: { authorization: 'Bearer abc123', note: 'token=abc123' },
            },
            meta: {
              eventId: 'event-detail',
              occurredAt: '2026-01-01T00:00:00Z',
              schemaVersion: 2,
              ownerPlugin: 'orders',
              exposure: ['internal'],
              scope: { tenantId: 'tenant-1', apiKey: 'hidden' },
              requestTenantId: 'tenant-1',
              requestId: 'request-1',
              correlationId: 'correlation-1',
              source: 'job',
            },
          }),
          'failed with token=abc123',
        ],
      );
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );

      expect(await operations.inspect('event-detail')).toMatchObject({
        eventId: 'event-detail',
        schemaVersion: 2,
        ownerPlugin: 'orders',
        requestTenantId: 'tenant-1',
        scope: { tenantId: 'tenant-1', apiKey: '[redacted]' },
        payloadPreview: {
          orderId: 'order-1',
          password: '[redacted]',
          nested: { authorization: '[redacted]', note: 'token=[redacted]' },
        },
        lastErrorMessage: 'failed with token=[redacted]',
      });
    } finally {
      db.close();
    }
  });

  test('retry preserves envelope and event identity and writes audit records', async () => {
    const db = database();
    try {
      insertOutbox(db, { id: 'dead', status: 'dead', createdAt: '2026-01-01T00:00:00Z' });
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );
      expect(
        await operations.retryEvent({
          eventId: 'event-dead',
          expectedVersion: 3,
          now: '2026-02-01T00:00:00Z',
          actor: 'operator',
          reason: 'broker restored',
        }),
      ).toBe(true);
      const row = db
        .query('SELECT event_id, envelope_json, status, attempts FROM slingshot_event_outbox')
        .get() as Record<string, unknown>;
      const audit = db.query('SELECT * FROM slingshot_event_replay_audit').get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        event_id: 'event-dead',
        envelope_json: '{"stable":"dead"}',
        status: 'pending',
        attempts: 0,
      });
      expect(audit).toMatchObject({
        event_id: 'event-dead',
        replayed_count: 1,
        actor: 'operator',
        reason: 'broker restored',
      });
      expect(await operations.listReplayAudit(10)).toEqual([
        expect.objectContaining({
          eventId: 'event-dead',
          replayedCount: 1,
          actor: 'operator',
          reason: 'broker restored',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  test('retention deletes only delivered outbox rows and old inbox receipts', async () => {
    const db = database();
    try {
      for (const status of ['pending', 'leased', 'dead'] as const) {
        insertOutbox(db, { id: status, status, createdAt: '2020-01-01T00:00:00Z' });
      }
      insertOutbox(db, {
        id: 'delivered-old',
        status: 'delivered',
        createdAt: '2020-01-01T00:00:00Z',
        deliveredAt: '2020-01-02T00:00:00Z',
      });
      insertOutbox(db, {
        id: 'delivered-new',
        status: 'delivered',
        createdAt: '2026-01-01T00:00:00Z',
        deliveredAt: '2026-01-02T00:00:00Z',
      });
      db.run(
        `INSERT INTO slingshot_event_inbox
          (consumer_name, event_id, event_key, processed_at, occurred_at)
         VALUES ('consumer', 'old', 'app:ready', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
                ('consumer', 'new', 'app:ready', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      );
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );

      expect(
        await operations.purgeDelivered({
          before: '2025-01-01T00:00:00Z',
          limit: 100,
          now: '2026-01-01T00:00:00Z',
          actor: 'retention',
          reason: 'expired',
        }),
      ).toBe(1);
      expect(
        await operations.purgeInbox({
          before: '2025-01-01T00:00:00Z',
          limit: 100,
          now: '2026-01-01T00:00:00Z',
          actor: 'retention',
          reason: 'expired',
        }),
      ).toBe(1);
      expect(
        (
          db.query('SELECT status FROM slingshot_event_outbox ORDER BY status').all() as Array<{
            status: string;
          }>
        ).map(row => row.status),
      ).toEqual(['dead', 'delivered', 'leased', 'pending']);
      expect(
        db.query('SELECT event_id FROM slingshot_event_inbox').all() as Array<{
          event_id: string;
        }>,
      ).toEqual([{ event_id: 'new' }]);
    } finally {
      db.close();
    }
  });

  test('writes a package-owned audit record for retention mutations', async () => {
    const db = database();
    try {
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );
      insertOutbox(db, {
        id: 'delivered-audit',
        status: 'delivered',
        createdAt: '2025-01-01T00:00:00Z',
        deliveredAt: '2025-01-01T00:00:00Z',
      });
      await operations.purgeDelivered({
        before: '2026-01-01T00:00:00Z',
        limit: 2,
        now: '2026-02-01T00:00:00Z',
        actor: 'operator',
        reason: 'retention window elapsed',
      });
      expect(
        db
          .query(
            `SELECT action, event_id, affected_count, actor, reason, created_at
             FROM slingshot_event_operator_audit`,
          )
          .get(),
      ).toEqual({
        action: 'purge-delivered',
        event_id: null,
        affected_count: 1,
        actor: 'operator',
        reason: 'retention window elapsed',
        created_at: '2026-02-01T00:00:00Z',
      });
    } finally {
      db.close();
    }
  });

  test('bulk replay is bounded and audited once', async () => {
    const db = database();
    try {
      for (const id of ['a', 'b', 'c']) {
        insertOutbox(db, { id, status: 'dead', createdAt: `2026-01-0${id.charCodeAt(0) - 96}Z` });
      }
      const operations = createSqliteEventReliabilityOperations(
        db as unknown as RuntimeSqliteDatabase,
      );
      expect(
        await operations.retryAllDead({
          now: '2026-02-01T00:00:00Z',
          actor: 'operator',
          reason: 'replay batch',
          limit: 2,
        }),
      ).toBe(2);
      expect(
        (
          (db
            .query(`SELECT COUNT(*) AS count FROM slingshot_event_outbox WHERE status = 'dead'`)
            .get() as { count: number } | null) ?? { count: 0 }
        ).count,
      ).toBe(1);
      expect(
        (
          (db.query('SELECT replayed_count FROM slingshot_event_replay_audit').get() as {
            replayed_count: number;
          } | null) ?? { replayed_count: 0 }
        ).replayed_count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });
});

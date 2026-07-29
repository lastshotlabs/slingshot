import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { NewOutboxRow, OutboxRepository } from './repository';

/** Create a SQLite outbox repository over the current scoped database handle. */
export function createSqliteOutboxRepository(db: RuntimeSqliteDatabase): OutboxRepository {
  return {
    insert(row: NewOutboxRow): void {
      db.run(
        `INSERT INTO slingshot_event_outbox (
          id, event_id, event_key, envelope_json, status, attempts,
          available_at, created_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        row.id,
        row.eventId,
        row.eventKey,
        row.envelopeJson,
        row.createdAt,
        row.createdAt,
      );
    },
  };
}

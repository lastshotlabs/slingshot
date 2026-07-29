import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { InboxRepository, NewInboxReceipt } from './repository';

/** Create a SQLite inbox repository over the active transaction connection. */
export function createSqliteInboxRepository(db: RuntimeSqliteDatabase): InboxRepository {
  return {
    insert(receipt: NewInboxReceipt): boolean {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO slingshot_event_inbox (
            consumer_name, event_id, event_key, processed_at, occurred_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.consumerName,
          receipt.eventId,
          receipt.eventKey,
          receipt.processedAt,
          receipt.occurredAt,
        );
      return result.changes === 1;
    },
  };
}

import type { PostgresBundle } from '@lastshotlabs/slingshot-core';
import type { InboxRepository, NewInboxReceipt } from './repository';

interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

/** Create a PostgreSQL inbox repository over the active transaction client. */
export function createPostgresInboxRepository(postgres: PostgresBundle): InboxRepository {
  const queryable = postgres.pool as unknown as Queryable;
  return {
    async insert(receipt: NewInboxReceipt): Promise<boolean> {
      const result = await queryable.query(
        `INSERT INTO slingshot_event_inbox (
          consumer_name, event_id, event_key, processed_at, occurred_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (consumer_name, event_id) DO NOTHING
        RETURNING event_id`,
        [
          receipt.consumerName,
          receipt.eventId,
          receipt.eventKey,
          receipt.processedAt,
          receipt.occurredAt,
        ],
      );
      return result.rows.length === 1;
    },
  };
}

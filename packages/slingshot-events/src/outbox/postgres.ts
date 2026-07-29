import type { PostgresBundle } from '@lastshotlabs/slingshot-core';
import type { NewOutboxRow, OutboxRepository } from './repository';

interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

/** Create a PostgreSQL outbox repository over the current scoped queryable. */
export function createPostgresOutboxRepository(postgres: PostgresBundle): OutboxRepository {
  const queryable = postgres.pool as unknown as Queryable;
  return {
    async insert(row: NewOutboxRow): Promise<void> {
      await queryable.query(
        `INSERT INTO slingshot_event_outbox (
          id, event_id, event_key, envelope_json, status, attempts,
          available_at, created_at
        ) VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, $5, $5)`,
        [row.id, row.eventId, row.eventKey, row.envelopeJson, row.createdAt],
      );
    },
  };
}

import type { PostgresBundle } from '@lastshotlabs/slingshot-core';
import type {
  LeasedOutboxRow,
  NewOutboxRow,
  OutboxDispatchRepository,
  OutboxRepository,
} from './repository';

interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowCount?: number | null }>;
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

interface PostgresClient extends Queryable {
  release(): void;
}

interface PostgresPool extends Queryable {
  connect(): Promise<PostgresClient>;
}

/** Create the PostgreSQL skip-locked lease/finalization repository. */
export function createPostgresOutboxDispatchRepository(
  postgres: PostgresBundle,
): OutboxDispatchRepository {
  const pool = postgres.pool as unknown as PostgresPool;
  return {
    async claim(input): Promise<readonly LeasedOutboxRow[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `WITH candidates AS (
             SELECT id
               FROM slingshot_event_outbox
              WHERE (status = 'pending' AND available_at <= $1)
                 OR (status = 'leased' AND lease_expires_at <= $1)
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED
              LIMIT $2
           )
           UPDATE slingshot_event_outbox AS outbox
              SET status = 'leased', lease_owner = $3, lease_expires_at = $4
             FROM candidates
            WHERE outbox.id = candidates.id
          RETURNING outbox.id, outbox.event_id, outbox.event_key,
                    outbox.envelope_json, outbox.attempts`,
          [input.now, input.limit, input.owner, input.leaseExpiresAt],
        );
        await client.query('COMMIT');
        return result.rows.map(row => ({
          id: String(row.id),
          eventId: String(row.event_id),
          eventKey: String(row.event_key),
          envelopeJson:
            typeof row.envelope_json === 'string'
              ? row.envelope_json
              : JSON.stringify(row.envelope_json),
          attempts: Number(row.attempts),
        }));
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the claim failure.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async markDelivered(input): Promise<boolean> {
      const result = await pool.query(
        `UPDATE slingshot_event_outbox
            SET status = 'delivered', delivered_at = $1,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $2 AND status = 'leased' AND lease_owner = $3`,
        [input.deliveredAt, input.id, input.owner],
      );
      return result.rowCount === 1;
    },
    async release(input): Promise<boolean> {
      const result = await pool.query(
        `UPDATE slingshot_event_outbox
            SET status = $1, attempts = $2, available_at = $3,
                last_error_code = $4, last_error_message = $5,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $6 AND status = 'leased' AND lease_owner = $7`,
        [
          input.dead ? 'dead' : 'pending',
          input.attempts,
          input.availableAt,
          input.errorCode,
          input.errorMessage,
          input.id,
          input.owner,
        ],
      );
      return result.rowCount === 1;
    },
    async releaseOwner(owner, now): Promise<number> {
      const result = await pool.query(
        `UPDATE slingshot_event_outbox
            SET status = 'pending', available_at = $1,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE status = 'leased' AND lease_owner = $2`,
        [now, owner],
      );
      return result.rowCount ?? 0;
    },
  };
}

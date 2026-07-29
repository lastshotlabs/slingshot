import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type {
  LeasedOutboxRow,
  NewOutboxRow,
  OutboxDispatchRepository,
  OutboxRepository,
} from './repository';

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

interface SqliteOutboxRow {
  id: string;
  event_id: string;
  event_key: string;
  envelope_json: string;
  attempts: number;
}

/** Create the SQLite lease/finalization repository used by one dispatcher loop. */
export function createSqliteOutboxDispatchRepository(
  db: RuntimeSqliteDatabase,
): OutboxDispatchRepository {
  return {
    async claim(input): Promise<readonly LeasedOutboxRow[]> {
      return db.transaction(() => {
        const candidates = db
          .query<SqliteOutboxRow>(
            `SELECT id, event_id, event_key, envelope_json, attempts
             FROM slingshot_event_outbox
            WHERE (status = 'pending' AND available_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
            ORDER BY created_at
            LIMIT ?`,
          )
          .all(input.now, input.now, input.limit);
        const claimed: LeasedOutboxRow[] = [];
        for (const row of candidates) {
          const result = db
            .prepare(
              `UPDATE slingshot_event_outbox
                  SET status = 'leased', lease_owner = ?, lease_expires_at = ?
                WHERE id = ?
                  AND ((status = 'pending' AND available_at <= ?)
                    OR (status = 'leased' AND lease_expires_at <= ?))`,
            )
            .run(input.owner, input.leaseExpiresAt, row.id, input.now, input.now);
          if (result.changes === 1) {
            claimed.push({
              id: row.id,
              eventId: row.event_id,
              eventKey: row.event_key,
              envelopeJson: row.envelope_json,
              attempts: row.attempts,
            });
          }
        }
        return claimed;
      })();
    },
    async markDelivered(input): Promise<boolean> {
      return (
        db
          .prepare(
            `UPDATE slingshot_event_outbox
                SET status = 'delivered', delivered_at = ?,
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
          )
          .run(input.deliveredAt, input.id, input.owner).changes === 1
      );
    },
    async release(input): Promise<boolean> {
      return (
        db
          .prepare(
            `UPDATE slingshot_event_outbox
                SET status = ?, attempts = ?, available_at = ?,
                    last_error_code = ?, last_error_message = ?,
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
          )
          .run(
            input.dead ? 'dead' : 'pending',
            input.attempts,
            input.availableAt,
            input.errorCode,
            input.errorMessage,
            input.id,
            input.owner,
          ).changes === 1
      );
    },
    async releaseOwner(owner, now): Promise<number> {
      return db
        .prepare(
          `UPDATE slingshot_event_outbox
              SET status = 'pending', available_at = ?,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE status = 'leased' AND lease_owner = ?`,
        )
        .run(now, owner).changes;
    },
  };
}

import type { PostgresBundle } from '@lastshotlabs/slingshot-core';
import type {
  EventReliabilityOperations,
  OutboxOperationalRow,
  OutboxOperationalStatus,
  OutboxStatus,
} from '../outbox/repository';

interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowCount?: number | null }>;
}

function count(rows: readonly Record<string, unknown>[], status: OutboxStatus): number {
  return Number(rows.find(row => row.status === status)?.count ?? 0);
}

/** Create PostgreSQL-backed reliability operations for health and CLI tooling. */
export function createPostgresEventReliabilityOperations(
  postgres: PostgresBundle,
): EventReliabilityOperations {
  const db = postgres.pool as unknown as Queryable;
  return {
    async status(now): Promise<OutboxOperationalStatus> {
      const [counts, pending, leases] = await Promise.all([
        db.query(`SELECT status, COUNT(*)::int AS count
                    FROM slingshot_event_outbox GROUP BY status`),
        db.query(`SELECT MIN(created_at) AS oldest
                    FROM slingshot_event_outbox WHERE status = 'pending'`),
        db.query(
          `SELECT COUNT(*)::int AS count
                    FROM slingshot_event_outbox
                   WHERE status = 'leased' AND lease_expires_at <= $1`,
          [now],
        ),
      ]);
      return {
        counts: {
          pending: count(counts.rows, 'pending'),
          leased: count(counts.rows, 'leased'),
          delivered: count(counts.rows, 'delivered'),
          dead: count(counts.rows, 'dead'),
        },
        oldestPendingAt: pending.rows[0]?.oldest
          ? new Date(String(pending.rows[0].oldest)).toISOString()
          : null,
        expiredLeases: Number(leases.rows[0]?.count ?? 0),
      };
    },
    async list(status, limit): Promise<readonly OutboxOperationalRow[]> {
      const result = await db.query(
        `SELECT id, event_id, event_key, status, attempts, available_at,
                lease_expires_at, created_at, delivered_at, last_error_code
           FROM slingshot_event_outbox
          WHERE status = $1 ORDER BY created_at LIMIT $2`,
        [status, limit],
      );
      return result.rows.map(row => ({
        id: String(row.id),
        eventId: String(row.event_id),
        eventKey: String(row.event_key),
        status: String(row.status) as OutboxStatus,
        attempts: Number(row.attempts),
        availableAt: new Date(String(row.available_at)).toISOString(),
        leaseExpiresAt: row.lease_expires_at
          ? new Date(String(row.lease_expires_at)).toISOString()
          : null,
        createdAt: new Date(String(row.created_at)).toISOString(),
        deliveredAt: row.delivered_at ? new Date(String(row.delivered_at)).toISOString() : null,
        lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
      }));
    },
    async retryEvent(input): Promise<boolean> {
      const result = await db.query(
        `WITH retried AS (
           UPDATE slingshot_event_outbox
              SET status = 'pending', attempts = 0, available_at = $1,
                  lease_owner = NULL, lease_expires_at = NULL,
                  last_error_code = NULL, last_error_message = NULL
            WHERE event_id = $2 AND status = 'dead'
        RETURNING event_id
         )
         INSERT INTO slingshot_event_replay_audit
           (id, event_id, replayed_count, actor, reason, created_at)
         SELECT $3, event_id, 1, $4, $5, $1 FROM retried
      RETURNING event_id`,
        [input.now, input.eventId, crypto.randomUUID(), input.actor, input.reason],
      );
      return result.rowCount === 1;
    },
    async retryAllDead(input): Promise<number> {
      const result = await db.query(
        `WITH candidates AS (
           SELECT id FROM slingshot_event_outbox
            WHERE status = 'dead' ORDER BY created_at LIMIT $1
         ), retried AS (
           UPDATE slingshot_event_outbox AS outbox
              SET status = 'pending', attempts = 0, available_at = $2,
                  lease_owner = NULL, lease_expires_at = NULL,
                  last_error_code = NULL, last_error_message = NULL
             FROM candidates WHERE outbox.id = candidates.id
        RETURNING outbox.id
         ), audited AS (
           INSERT INTO slingshot_event_replay_audit
             (id, event_id, replayed_count, actor, reason, created_at)
           SELECT $3, NULL, COUNT(*)::int, $4, $5, $2 FROM retried
           HAVING COUNT(*) > 0
        RETURNING replayed_count
         )
         SELECT replayed_count FROM audited`,
        [input.limit, input.now, crypto.randomUUID(), input.actor, input.reason],
      );
      return Number(result.rows[0]?.replayed_count ?? 0);
    },
    async purgeDelivered(before, limit): Promise<number> {
      const result = await db.query(
        `DELETE FROM slingshot_event_outbox
          WHERE id IN (
            SELECT id FROM slingshot_event_outbox
             WHERE status = 'delivered' AND delivered_at < $1
             ORDER BY delivered_at LIMIT $2
          )`,
        [before, limit],
      );
      return result.rowCount ?? 0;
    },
    async purgeInbox(before, limit): Promise<number> {
      const result = await db.query(
        `DELETE FROM slingshot_event_inbox
          WHERE (consumer_name, event_id) IN (
            SELECT consumer_name, event_id FROM slingshot_event_inbox
             WHERE processed_at < $1 ORDER BY processed_at LIMIT $2
          )`,
        [before, limit],
      );
      return result.rowCount ?? 0;
    },
  };
}

import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { projectStoredEventEnvelope, redactOperatorText } from '../operatorProjection';
import type {
  EventReliabilityOperations,
  OutboxOperationalDetail,
  OutboxOperationalRow,
  OutboxOperationalStatus,
  OutboxStatus,
} from '../outbox/repository';

interface CountRow {
  status: OutboxStatus;
  count: number;
}

interface SqliteOperationalRow {
  id: string;
  event_id: string;
  event_key: string;
  status: OutboxStatus;
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  created_at: string;
  delivered_at: string | null;
  last_error_code: string | null;
}

function operationalRow(row: SqliteOperationalRow): OutboxOperationalRow {
  return {
    id: row.id,
    eventId: row.event_id,
    eventKey: row.event_key,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    lastErrorCode: row.last_error_code,
  };
}

/** Create SQLite-backed reliability operations for health and CLI tooling. */
export function createSqliteEventReliabilityOperations(
  db: RuntimeSqliteDatabase,
): EventReliabilityOperations {
  return {
    async status(now): Promise<OutboxOperationalStatus> {
      const rows = db
        .query<CountRow>(
          'SELECT status, COUNT(*) AS count FROM slingshot_event_outbox GROUP BY status',
        )
        .all();
      const value = (status: OutboxStatus) =>
        Number(rows.find(row => row.status === status)?.count ?? 0);
      const pending = db
        .query<{ oldest: string | null }>(
          `SELECT MIN(created_at) AS oldest
             FROM slingshot_event_outbox WHERE status = 'pending'`,
        )
        .get();
      const leases = db
        .query<{ count: number }>(
          `SELECT COUNT(*) AS count FROM slingshot_event_outbox
            WHERE status = 'leased' AND lease_expires_at <= ?`,
        )
        .get(now);
      return {
        counts: {
          pending: value('pending'),
          leased: value('leased'),
          delivered: value('delivered'),
          dead: value('dead'),
        },
        oldestPendingAt: pending?.oldest ?? null,
        expiredLeases: Number(leases?.count ?? 0),
      };
    },
    async list(status, limit): Promise<readonly OutboxOperationalRow[]> {
      return db
        .query<SqliteOperationalRow>(
          `SELECT id, event_id, event_key, status, attempts, available_at,
                  lease_expires_at, created_at, delivered_at, last_error_code
             FROM slingshot_event_outbox
            WHERE status = ? ORDER BY created_at LIMIT ?`,
        )
        .all(status, limit)
        .map(operationalRow);
    },
    async inspect(eventId): Promise<OutboxOperationalDetail | null> {
      const row = db
        .query<
          SqliteOperationalRow & {
            envelope_json: string;
            last_error_message: string | null;
          }
        >(
          `SELECT id, event_id, event_key, envelope_json, status, attempts, available_at,
                  lease_expires_at, created_at, delivered_at, last_error_code, last_error_message
             FROM slingshot_event_outbox
            WHERE event_id = ? LIMIT 1`,
        )
        .get(eventId);
      if (!row) return null;
      return {
        ...operationalRow(row),
        ...projectStoredEventEnvelope(row.envelope_json),
        lastErrorMessage: row.last_error_message
          ? redactOperatorText(row.last_error_message)
          : null,
      };
    },
    async listReplayAudit(limit) {
      return db
        .query<{
          id: string;
          event_id: string | null;
          replayed_count: number;
          actor: string;
          reason: string;
          created_at: string;
        }>(
          `SELECT id, event_id, replayed_count, actor, reason, created_at
             FROM slingshot_event_replay_audit
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit)
        .map(row => ({
          id: row.id,
          eventId: row.event_id,
          replayedCount: row.replayed_count,
          actor: row.actor,
          reason: row.reason,
          createdAt: row.created_at,
        }));
    },
    async retryEvent(input): Promise<boolean> {
      return db.transaction(() => {
        const retried = db
          .prepare(
            `UPDATE slingshot_event_outbox
                SET status = 'pending', attempts = 0, available_at = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    last_error_code = NULL, last_error_message = NULL
              WHERE event_id = ? AND status = 'dead'`,
          )
          .run(input.now, input.eventId).changes;
        if (retried === 1) {
          db.run(
            `INSERT INTO slingshot_event_replay_audit
              (id, event_id, replayed_count, actor, reason, created_at)
             VALUES (?, ?, 1, ?, ?, ?)`,
            crypto.randomUUID(),
            input.eventId,
            input.actor,
            input.reason,
            input.now,
          );
        }
        return retried === 1;
      })();
    },
    async retryAllDead(input): Promise<number> {
      return db.transaction(() => {
        const result = db
          .prepare(
            `UPDATE slingshot_event_outbox
                SET status = 'pending', attempts = 0, available_at = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    last_error_code = NULL, last_error_message = NULL
              WHERE id IN (
                SELECT id FROM slingshot_event_outbox
                 WHERE status = 'dead' ORDER BY created_at LIMIT ?
              )`,
          )
          .run(input.now, input.limit);
        if (result.changes > 0) {
          db.run(
            `INSERT INTO slingshot_event_replay_audit
              (id, event_id, replayed_count, actor, reason, created_at)
             VALUES (?, NULL, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            result.changes,
            input.actor,
            input.reason,
            input.now,
          );
        }
        return result.changes;
      })();
    },
    async purgeDelivered(before, limit): Promise<number> {
      return db
        .prepare(
          `DELETE FROM slingshot_event_outbox
            WHERE id IN (
              SELECT id FROM slingshot_event_outbox
               WHERE status = 'delivered' AND delivered_at < ?
               ORDER BY delivered_at LIMIT ?
            )`,
        )
        .run(before, limit).changes;
    },
    async purgeInbox(before, limit): Promise<number> {
      return db
        .prepare(
          `DELETE FROM slingshot_event_inbox
            WHERE rowid IN (
              SELECT rowid FROM slingshot_event_inbox
               WHERE processed_at < ? ORDER BY processed_at LIMIT ?
            )`,
        )
        .run(before, limit).changes;
    },
  };
}

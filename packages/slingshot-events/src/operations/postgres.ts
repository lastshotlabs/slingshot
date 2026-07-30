import type { PostgresBundle } from '@lastshotlabs/slingshot-core';
import { projectStoredEventEnvelope, redactOperatorText } from '../operatorProjection';
import type {
  EventReliabilityOperations,
  EventReliabilityOperationsOptions,
  OutboxOperationalDetail,
  OutboxOperationalRow,
  OutboxOperationalStatus,
  OutboxReplayAudit,
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

function operationalRow(row: Record<string, unknown>): OutboxOperationalRow {
  return {
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
  };
}

/** Create PostgreSQL-backed reliability operations for health and CLI tooling. */
export function createPostgresEventReliabilityOperations(
  postgres: PostgresBundle,
  options: EventReliabilityOperationsOptions = {},
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
      return result.rows.map(operationalRow);
    },
    async inspect(eventId): Promise<OutboxOperationalDetail | null> {
      const result = await db.query(
        `SELECT id, event_id, event_key, envelope_json, status, attempts, available_at,
                lease_expires_at, created_at, delivered_at, last_error_code, last_error_message
           FROM slingshot_event_outbox
          WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...operationalRow(row),
        ...projectStoredEventEnvelope(String(row.envelope_json)),
        lastErrorMessage: row.last_error_message
          ? redactOperatorText(String(row.last_error_message))
          : null,
      };
    },
    async validateReplay(eventId) {
      const result = await db.query(
        `SELECT event_key, envelope_json
           FROM slingshot_event_outbox
          WHERE event_id = $1 AND status = 'dead' LIMIT 1`,
        [eventId],
      );
      const row = result.rows[0];
      if (!row) {
        return {
          compatible: false,
          eventKey: '',
          storedVersion: 1,
          currentVersion: null,
          reason: 'invalid-envelope',
        };
      }
      if (!options.replayValidator) {
        return {
          compatible: false,
          eventKey: String(row.event_key),
          storedVersion: projectStoredEventEnvelope(String(row.envelope_json)).schemaVersion,
          currentVersion: null,
          reason: 'validator-unavailable',
        };
      }
      return options.replayValidator.validate(String(row.envelope_json), String(row.event_key));
    },
    async listReplayAudit(limit): Promise<readonly OutboxReplayAudit[]> {
      const result = await db.query(
        `SELECT id, event_id, replayed_count, actor, reason, created_at
           FROM slingshot_event_replay_audit
          ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(row => ({
        id: String(row.id),
        eventId: row.event_id ? String(row.event_id) : null,
        replayedCount: Number(row.replayed_count),
        actor: String(row.actor),
        reason: String(row.reason),
        createdAt: new Date(String(row.created_at)).toISOString(),
      }));
    },
    async retryEvent(input): Promise<boolean> {
      const result = await db.query(
        `WITH retried AS (
           UPDATE slingshot_event_outbox
              SET status = 'pending', attempts = 0, available_at = $1,
                  lease_owner = NULL, lease_expires_at = NULL,
                  last_error_code = NULL, last_error_message = NULL
            WHERE event_id = $2 AND status = 'dead' AND attempts = $6
        RETURNING event_id
         )
         INSERT INTO slingshot_event_replay_audit
           (id, event_id, replayed_count, actor, reason, created_at)
         SELECT $3, event_id, 1, $4, $5, $1 FROM retried
      RETURNING event_id`,
        [
          input.now,
          input.eventId,
          crypto.randomUUID(),
          input.actor,
          input.reason,
          input.expectedVersion,
        ],
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
    async purgeDelivered(input): Promise<number> {
      const result = await db.query(
        `WITH purged AS (
          DELETE FROM slingshot_event_outbox
           WHERE id IN (
            SELECT id FROM slingshot_event_outbox
             WHERE status = 'delivered' AND delivered_at < $1
             ORDER BY delivered_at LIMIT $2
           )
        RETURNING id
         ), audited AS (
          INSERT INTO slingshot_event_operator_audit
            (id, action, event_id, affected_count, actor, reason, created_at)
          SELECT $3, 'purge-delivered', NULL, COUNT(*)::int, $4, $5, $6 FROM purged
        RETURNING affected_count
         )
         SELECT affected_count FROM audited`,
        [input.before, input.limit, crypto.randomUUID(), input.actor, input.reason, input.now],
      );
      return Number(result.rows[0]?.affected_count ?? 0);
    },
    async purgeInbox(input): Promise<number> {
      const result = await db.query(
        `WITH purged AS (
          DELETE FROM slingshot_event_inbox
           WHERE (consumer_name, event_id) IN (
            SELECT consumer_name, event_id FROM slingshot_event_inbox
             WHERE processed_at < $1 ORDER BY processed_at LIMIT $2
           )
        RETURNING event_id
         ), audited AS (
          INSERT INTO slingshot_event_operator_audit
            (id, action, event_id, affected_count, actor, reason, created_at)
          SELECT $3, 'purge-inbox', NULL, COUNT(*)::int, $4, $5, $6 FROM purged
        RETURNING affected_count
         )
         SELECT affected_count FROM audited`,
        [input.before, input.limit, crypto.randomUUID(), input.actor, input.reason, input.now],
      );
      return Number(result.rows[0]?.affected_count ?? 0);
    },
  };
}

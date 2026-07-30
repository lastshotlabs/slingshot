import type { EventReliabilityMigration } from './types';

/** SQLite schema migration for event outbox, inbox, and package ledger. */
export const SQLITE_EVENT_RELIABILITY_MIGRATIONS: readonly EventReliabilityMigration[] =
  Object.freeze([
    Object.freeze({
      version: 1,
      checksum: 'wp4-sqlite-v1-outbox-inbox',
      statements: Object.freeze([
        `CREATE TABLE IF NOT EXISTS slingshot_event_reliability_migrations (
          version INTEGER PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS slingshot_event_outbox (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          event_key TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_outbox_delivery_idx
          ON slingshot_event_outbox (status, available_at, created_at)`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_outbox_lease_idx
          ON slingshot_event_outbox (status, lease_expires_at)`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_outbox_retention_idx
          ON slingshot_event_outbox (delivered_at)`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_outbox_event_idx
          ON slingshot_event_outbox (event_key, created_at)`,
        `CREATE TABLE IF NOT EXISTS slingshot_event_inbox (
          consumer_name TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_key TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (consumer_name, event_id)
        )`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_inbox_event_idx
          ON slingshot_event_inbox (event_key, occurred_at)`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_inbox_retention_idx
          ON slingshot_event_inbox (processed_at)`,
      ]),
    }),
    Object.freeze({
      version: 2,
      checksum: 'wp4-sqlite-v2-replay-audit',
      statements: Object.freeze([
        `CREATE TABLE IF NOT EXISTS slingshot_event_replay_audit (
          id TEXT PRIMARY KEY,
          event_id TEXT,
          replayed_count INTEGER NOT NULL CHECK (replayed_count > 0),
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_replay_audit_created_idx
          ON slingshot_event_replay_audit (created_at)`,
      ]),
    }),
    Object.freeze({
      version: 3,
      checksum: 'wp5-sqlite-v3-operator-audit',
      statements: Object.freeze([
        `CREATE TABLE IF NOT EXISTS slingshot_event_operator_audit (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL CHECK (
            action IN ('retry', 'retry-dead', 'purge-delivered', 'purge-inbox')
          ),
          event_id TEXT,
          affected_count INTEGER NOT NULL CHECK (affected_count >= 0),
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_operator_audit_created_idx
          ON slingshot_event_operator_audit (created_at)`,
      ]),
    }),
  ]);

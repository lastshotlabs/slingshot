import type { EventReliabilityMigration } from './types';

/** PostgreSQL schema migration for event outbox, inbox, and package ledger. */
export const POSTGRES_EVENT_RELIABILITY_MIGRATIONS: readonly EventReliabilityMigration[] =
  Object.freeze([
    Object.freeze({
      version: 1,
      checksum: 'wp4-pg-v1-outbox-inbox',
      statements: Object.freeze([
        `CREATE TABLE IF NOT EXISTS slingshot_event_reliability_migrations (
          version INTEGER PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS slingshot_event_outbox (
          id UUID PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          event_key TEXT NOT NULL,
          envelope_json JSONB NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at TIMESTAMPTZ NOT NULL,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          delivered_at TIMESTAMPTZ
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
          processed_at TIMESTAMPTZ NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (consumer_name, event_id)
        )`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_inbox_event_idx
          ON slingshot_event_inbox (event_key, occurred_at)`,
        `CREATE INDEX IF NOT EXISTS slingshot_event_inbox_retention_idx
          ON slingshot_event_inbox (processed_at)`,
      ]),
    }),
  ]);

import type {
  PostgresBundle,
  RuntimeSqliteDatabase,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import { EventReliabilityTopologyError } from '../errors';
import type { EventReliabilityConfig } from '../types';
import { POSTGRES_EVENT_RELIABILITY_MIGRATIONS } from './postgres';
import { type EventReliabilityMigrationSession, applyEventReliabilityMigrations } from './runner';
import { SQLITE_EVENT_RELIABILITY_MIGRATIONS } from './sqlite';

interface PostgresResult {
  readonly rows: readonly Record<string, unknown>[];
}

interface PostgresClient {
  query(sql: string, params?: readonly unknown[]): Promise<PostgresResult>;
  release(): void;
}

interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

async function initializePostgres(postgres: PostgresBundle): Promise<void> {
  const client = await (postgres.pool as unknown as PostgresPool).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('slingshot_event_reliability'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS slingshot_event_reliability_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const result = await client.query(
      'SELECT version, checksum FROM slingshot_event_reliability_migrations',
    );
    const applied = new Map(
      result.rows.map(row => [Number(row.version), String(row.checksum)] as const),
    );
    await applyEventReliabilityMigrations(
      {
        async transaction(callback): Promise<void> {
          const session: EventReliabilityMigrationSession = {
            applied,
            async execute(statement): Promise<void> {
              await client.query(statement);
            },
            async record(version, checksum): Promise<void> {
              await client.query(
                `INSERT INTO slingshot_event_reliability_migrations
                  (version, checksum) VALUES ($1, $2)`,
                [version, checksum],
              );
              applied.set(version, checksum);
            },
          };
          await callback(session);
        },
      },
      POSTGRES_EVENT_RELIABILITY_MIGRATIONS,
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function initializeSqlite(db: RuntimeSqliteDatabase): void {
  const migrate = db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS slingshot_event_reliability_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const rows = db
      .query<{
        version: number;
        checksum: string;
      }>('SELECT version, checksum FROM slingshot_event_reliability_migrations')
      .all();
    const applied = new Map(rows.map(row => [row.version, row.checksum] as const));
    for (const migration of SQLITE_EVENT_RELIABILITY_MIGRATIONS) {
      const appliedChecksum = applied.get(migration.version);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== migration.checksum) {
          throw new EventReliabilityTopologyError(
            `Event reliability migration ${migration.version} checksum mismatch.`,
          );
        }
        continue;
      }
      for (const statement of migration.statements) db.run(statement);
      db.run(
        `INSERT INTO slingshot_event_reliability_migrations
          (version, checksum, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.checksum,
        new Date().toISOString(),
      );
      applied.set(migration.version, migration.checksum);
    }
  });
  migrate();
}

/** Apply package-owned reliability migrations before dispatchers or consumers start. */
export async function initializeEventReliabilityStore(
  infra: StoreInfra,
  config: EventReliabilityConfig,
): Promise<void> {
  if (config.store === 'postgres') {
    await initializePostgres(infra.getPostgres());
    return;
  }
  initializeSqlite(infra.getSqliteDb());
}

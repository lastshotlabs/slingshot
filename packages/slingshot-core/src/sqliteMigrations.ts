import type { RuntimeSqliteDatabase } from './runtime';

function parseSqliteMigrationVersion(
  raw: unknown,
  subsystem: string,
  maxVersion: number,
): number {
  if (raw === null || raw === undefined) return 0;
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw new Error(
      `[sqlite-migrations] Invalid schema version for subsystem '${subsystem}': ${String(raw)}`,
    );
  }
  const version = raw as number;
  if (version > maxVersion) {
    throw new Error(
      `[sqlite-migrations] Subsystem '${subsystem}' is at schema version ${version}, but this binary only supports up to version ${maxVersion}.`,
    );
  }
  return version;
}

/**
 * Per-subsystem SQLite migration runner.
 *
 * Tracks applied migrations in a shared `_slingshot_migrations` table keyed by
 * subsystem name, rather than the global `PRAGMA user_version`. This allows
 * multiple subsystems (auth, permissions, webhooks, push) to share the same
 * SQLite file without colliding on the single global version integer.
 *
 * The `_slingshot_migrations` table is created automatically if it doesn't exist.
 * Each row records the highest migration index applied for a given subsystem.
 *
 * @param db - The SQLite database handle.
 * @param subsystem - A stable identifier for this subsystem (e.g. `'auth'`, `'permissions'`).
 * @param migrations - Ordered array of migration functions. Indexes are 0-based; version is
 *   index + 1. Migrations are applied in order starting from the subsystem's current version.
 *
 * @example
 * ```ts
 * const MIGRATIONS: Array<(db: RuntimeSqliteDatabase) => void> = [
 *   (db) => { db.run('CREATE TABLE foo (id TEXT PRIMARY KEY)'); }, // v1
 *   (db) => { db.run('ALTER TABLE foo ADD COLUMN bar TEXT'); },    // v2
 * ];
 *
 * runSubsystemMigrations(db, 'my-plugin', MIGRATIONS);
 * ```
 */
export function runSubsystemMigrations(
  db: RuntimeSqliteDatabase,
  subsystem: string,
  migrations: ReadonlyArray<(db: RuntimeSqliteDatabase) => void>,
): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _slingshot_migrations (
      subsystem TEXT NOT NULL PRIMARY KEY,
      version   INTEGER NOT NULL
    )
  `);

  const row = db
    .query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?')
    .get(subsystem);
  const currentVersion = parseSqliteMigrationVersion(row?.version, subsystem, migrations.length);

  for (let i = currentVersion; i < migrations.length; i++) {
    const applyMigration = db.transaction(() => {
      migrations[i](db);
      db.run(
        `INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)
         ON CONFLICT (subsystem) DO UPDATE SET version = excluded.version`,
        subsystem,
        i + 1,
      );
    });
    applyMigration();
  }
}

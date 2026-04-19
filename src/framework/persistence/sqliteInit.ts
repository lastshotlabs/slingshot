interface SqliteInitializerDb {
  run(sql: string, params?: unknown[]): unknown;
}

export function createSqliteInitializer(
  db: SqliteInitializerDb,
  initSchema: () => void,
): () => void {
  let initialized = false;

  return () => {
    if (initialized) return;

    let inTransaction = false;
    try {
      db.run('PRAGMA busy_timeout = 5000');
      db.run('BEGIN IMMEDIATE');
      inTransaction = true;

      initSchema();

      db.run('COMMIT');
      inTransaction = false;
      initialized = true;
    } catch (error) {
      if (inTransaction) {
        try {
          db.run('ROLLBACK');
        } catch {
          // Preserve the original bootstrap failure.
        }
      }
      throw error;
    }
  };
}

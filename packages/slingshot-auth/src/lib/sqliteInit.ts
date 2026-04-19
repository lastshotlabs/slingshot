import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';

export function createSqliteInitializer(
  db: RuntimeSqliteDatabase,
  initSchema: () => void,
): () => void {
  let initialized = false;

  return () => {
    if (initialized) return;

    let inTransaction = false;
    try {
      // Let a concurrent process finish its schema bootstrap instead of failing
      // immediately with "database is locked".
      db.run('PRAGMA busy_timeout = 5000');
      db.run('BEGIN IMMEDIATE');
      inTransaction = true;

      initSchema();

      db.run('COMMIT');
      inTransaction = false;
      initialized = true;
    } catch (err) {
      if (inTransaction) {
        try {
          db.run('ROLLBACK');
        } catch {
          // Preserve the original bootstrap failure.
        }
      }
      throw err;
    }
  };
}

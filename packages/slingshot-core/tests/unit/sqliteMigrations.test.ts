import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runSubsystemMigrations } from '../../src/sqliteMigrations';
import type { RuntimeSqliteDatabase } from '../../src/runtime';

function createTestDb(): RuntimeSqliteDatabase {
  const raw = new Database(':memory:');
  return {
    run(sql: string, ...args: unknown[]) {
      raw.run(sql, ...(args as [Record<string, unknown>]));
    },
    query<T>(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        get(...args: unknown[]) {
          return stmt.get(...(args as [Record<string, unknown>])) as T | undefined;
        },
        all(...args: unknown[]) {
          return stmt.all(...(args as [Record<string, unknown>])) as T[];
        },
      };
    },
  };
}

describe('runSubsystemMigrations', () => {
  test('creates migration table and runs all migrations', () => {
    const db = createTestDb();
    const migrations = [
      (d: RuntimeSqliteDatabase) => d.run('CREATE TABLE foo (id TEXT PRIMARY KEY)'),
      (d: RuntimeSqliteDatabase) => d.run('ALTER TABLE foo ADD COLUMN bar TEXT'),
    ];
    runSubsystemMigrations(db, 'test-plugin', migrations);

    const row = db.query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?').get('test-plugin');
    expect(row?.version).toBe(2);
  });

  test('skips already-applied migrations on re-run', () => {
    const db = createTestDb();
    let callCount = 0;
    const migrations = [
      (d: RuntimeSqliteDatabase) => {
        callCount++;
        d.run('CREATE TABLE counter (id INTEGER)');
      },
    ];
    runSubsystemMigrations(db, 'counter', migrations);
    expect(callCount).toBe(1);

    runSubsystemMigrations(db, 'counter', migrations);
    expect(callCount).toBe(1); // not called again
  });

  test('multiple subsystems share the same migration table', () => {
    const db = createTestDb();
    runSubsystemMigrations(db, 'auth', [
      (d: RuntimeSqliteDatabase) => d.run('CREATE TABLE auth_sessions (id TEXT)'),
    ]);
    runSubsystemMigrations(db, 'perms', [
      (d: RuntimeSqliteDatabase) => d.run('CREATE TABLE perm_grants (id TEXT)'),
      (d: RuntimeSqliteDatabase) => d.run('ALTER TABLE perm_grants ADD COLUMN role TEXT'),
    ]);

    const authRow = db.query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?').get('auth');
    const permsRow = db.query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?').get('perms');
    expect(authRow?.version).toBe(1);
    expect(permsRow?.version).toBe(2);
  });

  test('empty migrations array is a no-op', () => {
    const db = createTestDb();
    runSubsystemMigrations(db, 'empty', []);
    const row = db.query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?').get('empty');
    // bun:sqlite .get() returns null when no row found
    expect(row).toBeNull();
  });
});

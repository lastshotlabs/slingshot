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
    prepare<T>(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        get(...args: unknown[]) {
          return stmt.get(...(args as [Record<string, unknown>])) as T | null;
        },
        all(...args: unknown[]) {
          return stmt.all(...(args as [Record<string, unknown>])) as T[];
        },
        run(...args: unknown[]) {
          return stmt.run(...(args as [Record<string, unknown>])) as { changes: number };
        },
      };
    },
    transaction<T>(fn: () => T) {
      const tx = raw.transaction(fn);
      return () => tx();
    },
    close() {
      raw.close();
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

  test('rolls back migration work when version update fails', () => {
    const raw = new Database(':memory:');
    raw.run('CREATE TABLE items (id TEXT PRIMARY KEY)');

    let failVersionWrite = true;
    const db: RuntimeSqliteDatabase = {
      run(sql: string, ...args: unknown[]) {
        if (failVersionWrite && sql.includes('INSERT INTO _slingshot_migrations')) {
          throw new Error('version write failed');
        }
        raw.run(sql, ...(args as [Record<string, unknown>]));
      },
      query<T>(sql: string) {
        const stmt = raw.prepare(sql);
        return {
          get(...args: unknown[]) {
            return stmt.get(...(args as [Record<string, unknown>])) as T | null;
          },
          all(...args: unknown[]) {
            return stmt.all(...(args as [Record<string, unknown>])) as T[];
          },
        };
      },
      prepare<T>(sql: string) {
        const stmt = raw.prepare(sql);
        return {
          get(...args: unknown[]) {
            return stmt.get(...(args as [Record<string, unknown>])) as T | null;
          },
          all(...args: unknown[]) {
            return stmt.all(...(args as [Record<string, unknown>])) as T[];
          },
          run(...args: unknown[]) {
            return stmt.run(...(args as [Record<string, unknown>])) as { changes: number };
          },
        };
      },
      transaction<T>(fn: () => T) {
        const tx = raw.transaction(fn);
        return () => tx();
      },
      close() {
        raw.close();
      },
    };

    expect(() =>
      runSubsystemMigrations(db, 'atomic', [
        d => {
          d.run('INSERT INTO items (id) VALUES (?)', 'rolled-back');
        },
      ]),
    ).toThrow('version write failed');

    const rows = raw.query<{ id: string }, []>('SELECT id FROM items').all();
    const migrationTable = raw
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get('_slingshot_migrations');

    expect(rows).toEqual([]);
    expect(migrationTable).toBeNull();

    failVersionWrite = false;
    runSubsystemMigrations(db, 'atomic', [
      d => {
        d.run('INSERT INTO items (id) VALUES (?)', 'committed');
      },
    ]);

    const committedRows = raw.query<{ id: string }, []>('SELECT id FROM items').all();
    expect(committedRows).toEqual([{ id: 'committed' }]);
  });

  test('takes an immediate write lock before reading the current version', () => {
    const calls: string[] = [];
    const db: RuntimeSqliteDatabase = {
      run(sql: string) {
        calls.push(sql.trim());
      },
      query<T>(_sql: string) {
        calls.push('SELECT version');
        return {
          get() {
            return null as T | null;
          },
          all() {
            return [] as T[];
          },
        };
      },
      prepare<T>() {
        return {
          get() {
            return null as T | null;
          },
          all() {
            return [] as T[];
          },
          run() {
            return { changes: 0 };
          },
        };
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
      close() {},
    };

    runSubsystemMigrations(db, 'lock-order', []);

    expect(calls[0]).toBe('PRAGMA busy_timeout = 5000');
    expect(calls[1]).toBe('BEGIN IMMEDIATE');
    expect(calls[2]).toContain('CREATE TABLE IF NOT EXISTS _slingshot_migrations');
    expect(calls[3]).toBe('SELECT version');
    expect(calls.at(-1)).toBe('COMMIT');
  });

  test('fails closed when subsystem version is newer than this binary supports', () => {
    const db = createTestDb();
    db.run(`CREATE TABLE IF NOT EXISTS _slingshot_migrations (
      subsystem TEXT NOT NULL PRIMARY KEY,
      version   INTEGER NOT NULL
    )`);
    db.run(
      'INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)',
      'future-subsystem',
      3,
    );

    expect(() =>
      runSubsystemMigrations(db, 'future-subsystem', [
        d => d.run('CREATE TABLE safe_table (id TEXT PRIMARY KEY)'),
      ]),
    ).toThrow("Subsystem 'future-subsystem' is at schema version 3");
  });

  test('fails closed when subsystem version row is corrupt', () => {
    const db = createTestDb();
    db.run(`CREATE TABLE IF NOT EXISTS _slingshot_migrations (
      subsystem TEXT NOT NULL PRIMARY KEY,
      version   INTEGER NOT NULL
    )`);
    db.run("INSERT INTO _slingshot_migrations (subsystem, version) VALUES ('corrupt', 'abc')");

    expect(() =>
      runSubsystemMigrations(db, 'corrupt', [d => d.run('CREATE TABLE nope (id TEXT PRIMARY KEY)')]),
    ).toThrow("Invalid schema version for subsystem 'corrupt'");
  });
});

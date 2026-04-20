import { createSqliteInitializer } from '@auth/lib/sqliteInit';
import { describe, expect, test } from 'bun:test';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';

function createMockDb(options?: {
  failSql?: string;
  failTimes?: number;
  calls?: string[];
}): RuntimeSqliteDatabase {
  const calls = options?.calls ?? [];
  let remainingFailures = options?.failTimes ?? 0;

  return {
    run(sql: string) {
      const normalized = sql.trim();
      calls.push(normalized);
      if (options?.failSql === normalized && remainingFailures > 0) {
        remainingFailures--;
        throw new Error(`forced failure: ${normalized}`);
      }
    },
    query<T>(_sql: string) {
      return {
        get() {
          return null as T | null;
        },
        all() {
          return [] as T[];
        },
      };
    },
    prepare<T>(_sql: string) {
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
}

describe('createSqliteInitializer', () => {
  test('takes a write lock before running schema bootstrap and commits once', () => {
    const calls: string[] = [];
    const db = createMockDb({ calls });
    let initCalls = 0;

    const init = createSqliteInitializer(db, () => {
      initCalls++;
      db.run('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)');
    });

    init();
    init();

    expect(initCalls).toBe(1);
    expect(calls).toEqual([
      'PRAGMA busy_timeout = 5000',
      'BEGIN IMMEDIATE',
      'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
      'COMMIT',
    ]);
  });

  test('rolls back failed bootstrap work and retries on the next call', () => {
    const calls: string[] = [];
    const db = createMockDb({
      calls,
      failSql: 'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
      failTimes: 1,
    });
    let attempts = 0;

    const init = createSqliteInitializer(db, () => {
      attempts++;
      db.run('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)');
    });

    expect(() => init()).toThrow(
      'forced failure: CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
    );
    expect(attempts).toBe(1);
    expect(calls).toEqual([
      'PRAGMA busy_timeout = 5000',
      'BEGIN IMMEDIATE',
      'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
      'ROLLBACK',
    ]);

    calls.length = 0;
    init();

    expect(attempts).toBe(2);
    expect(calls).toEqual([
      'PRAGMA busy_timeout = 5000',
      'BEGIN IMMEDIATE',
      'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
      'COMMIT',
    ]);
  });

  test('rolls back when commit itself fails', () => {
    const calls: string[] = [];
    const db = createMockDb({
      calls,
      failSql: 'COMMIT',
      failTimes: 1,
    });

    const init = createSqliteInitializer(db, () => {
      db.run('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)');
    });

    expect(() => init()).toThrow('forced failure: COMMIT');
    expect(calls).toEqual([
      'PRAGMA busy_timeout = 5000',
      'BEGIN IMMEDIATE',
      'CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY)',
      'COMMIT',
      'ROLLBACK',
    ]);
  });
});

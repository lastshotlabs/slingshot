/**
 * Unit tests for migration version parsing, advisory lock control, rollback
 * behavior, and version detection.
 *
 * `parseMigrationVersion` is now exported from the adapter module so tests
 * import it directly instead of duplicating the logic. `runMigrations` is
 * tested through the public `createPostgresAdapter` factory by controlling
 * what the mock `pg` pool client returns (version, failure injection, etc.).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { attachPostgresPoolRuntime, createPostgresPoolRuntime } from '@lastshotlabs/slingshot-core';
import { createPostgresAdapter, parseMigrationVersion } from '../src/adapter.js';

// ---------------------------------------------------------------------------
// Pure function: parseMigrationVersion (now imported from the adapter module)
// ---------------------------------------------------------------------------

const MIGRATION_COUNT = 2; // matches src/adapter.ts MIGRATIONS.length

describe('parseMigrationVersion (pure logic)', () => {
  const maxVersion = 5;

  test('accepts a valid number', () => {
    expect(parseMigrationVersion(0, maxVersion)).toBe(0);
    expect(parseMigrationVersion(3, maxVersion)).toBe(3);
    expect(parseMigrationVersion(5, maxVersion)).toBe(5);
  });

  test('accepts a valid numeric string', () => {
    expect(parseMigrationVersion('0', maxVersion)).toBe(0);
    expect(parseMigrationVersion('3', maxVersion)).toBe(3);
    expect(parseMigrationVersion('5', maxVersion)).toBe(5);
  });

  test('throws when db version is greater than binary max version (number)', () => {
    expect(() => parseMigrationVersion(6, maxVersion)).toThrow(
      '[slingshot-postgres] Database schema version 6 is newer than this binary supports (5)',
    );
  });

  test('throws when db version is greater than binary max version (string)', () => {
    expect(() => parseMigrationVersion('6', maxVersion)).toThrow(
      '[slingshot-postgres] Database schema version 6 is newer than this binary supports (5)',
    );
  });

  test('throws on negative numbers', () => {
    expect(() => parseMigrationVersion(-1, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: -1',
    );
  });

  test('throws on negative string numbers', () => {
    expect(() => parseMigrationVersion('-1', maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: -1',
    );
  });

  test('throws on non-numeric strings', () => {
    expect(() => parseMigrationVersion('abc', maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: abc',
    );
  });

  test('throws on null', () => {
    expect(() => parseMigrationVersion(null, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: null',
    );
  });

  test('throws on undefined', () => {
    expect(() => parseMigrationVersion(undefined, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: undefined',
    );
  });

  test('throws on objects', () => {
    expect(() => parseMigrationVersion({}, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: [object Object]',
    );
  });

  test('throws on floating point number', () => {
    expect(() => parseMigrationVersion(3.5, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: 3.5',
    );
  });

  test('throws on boolean', () => {
    expect(() => parseMigrationVersion(true, maxVersion)).toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: true',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration-through-factory tests for runMigrations
// ---------------------------------------------------------------------------

let mockDbImpl: Record<string, unknown> | null = null;
let mockMigrationVersion: number | string = 0;
let mockAdvisoryLockCalled = false;
let mockCommitCalled = false;
let mockRollbackCalled = false;
let mockBeginCalled = false;
let mockConnectCount = 0;
let failNextMigration = false;
let failOnBegin = false;

mock.module('pg', () => ({
  Pool: class MockPool {
    connect() {
      mockConnectCount++;
      return Promise.resolve({
        query(sql: string) {
          // Track key transaction lifecycle calls
          if (sql.trim().startsWith('BEGIN')) {
            mockBeginCalled = true;
            if (failOnBegin) return Promise.reject(new Error('begin failed'));
          }
          if (sql.includes('pg_advisory_xact_lock')) {
            mockAdvisoryLockCalled = true;
          }
          if (sql.includes('SELECT COALESCE(MAX(version), 0) AS version')) {
            return Promise.resolve({ rows: [{ version: mockMigrationVersion }], rowCount: 1 });
          }
          if (sql.trim().startsWith('COMMIT')) {
            mockCommitCalled = true;
          }
          if (sql.trim().startsWith('ROLLBACK')) {
            mockRollbackCalled = true;
          }
          // Migrations v1 — CREATE TABLE statements
          if (sql.includes('CREATE TABLE IF NOT EXISTS slingshot_users')) {
            if (failNextMigration) {
              failNextMigration = false;
              return Promise.reject(new Error('migration v1 failed'));
            }
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      });
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (!mockDbImpl) throw new Error('mockDbImpl not set');
          const impl = mockDbImpl as Record<string | symbol, unknown>;
          if (prop in impl) return impl[prop];
          throw new Error(`mockDbImpl missing method: ${String(prop)}`);
        },
      },
    ),
}));

describe('runMigrations (through createPostgresAdapter factory)', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 0;
    mockAdvisoryLockCalled = false;
    mockCommitCalled = false;
    mockRollbackCalled = false;
    mockBeginCalled = false;
    mockConnectCount = 0;
    failNextMigration = false;
    failOnBegin = false;

    // Set up minimal mockDbImpl so drizzle returns workable proxies
    mockDbImpl = {
      select: () =>
        new Proxy(
          {},
          {
            get() {
              return () => (mockDbImpl?.select as () => unknown)();
            },
          },
        ) as unknown,
      insert: () =>
        new Proxy(
          {},
          {
            get() {
              return () => undefined;
            },
          },
        ) as unknown,
      update: () =>
        new Proxy(
          {},
          {
            get() {
              return () => undefined;
            },
          },
        ) as unknown,
      delete: () =>
        new Proxy(
          {},
          {
            get() {
              return () => undefined;
            },
          },
        ) as unknown,
    };
  });

  test('applies all pending migrations when version is 0', async () => {
    mockMigrationVersion = 0;
    const pool = new (await import('pg')).Pool();
    await createPostgresAdapter({ pool });

    expect(mockBeginCalled).toBe(true);
    expect(mockAdvisoryLockCalled).toBe(true);
    expect(mockCommitCalled).toBe(true);
    expect(mockRollbackCalled).toBe(false);
    expect(mockConnectCount).toBeGreaterThanOrEqual(1);
  });

  test('skips migrations when db is already at latest version', async () => {
    mockMigrationVersion = 2; // matches MIGRATIONS.length
    // Reset tracking flags
    mockBeginCalled = false;
    mockAdvisoryLockCalled = false;
    mockCommitCalled = false;

    const pool = new (await import('pg')).Pool();
    await createPostgresAdapter({ pool });

    // Migration logic runs but with 0 pending — version table is canonicalized
    expect(mockBeginCalled).toBe(true);
    expect(mockAdvisoryLockCalled).toBe(true);
    expect(mockCommitCalled).toBe(true);
  });

  test('rolls back entire transaction when a migration fails', async () => {
    mockMigrationVersion = 0;
    failNextMigration = true;

    const pool = new (await import('pg')).Pool();
    await expect(createPostgresAdapter({ pool })).rejects.toThrow('migration v1 failed');

    // Should have rolled back
    expect(mockRollbackCalled).toBe(true);
    // Commit should NOT have been called after rollback
    expect(mockCommitCalled).toBe(false);
  });

  test('does not apply already-run migrations when version is 1', async () => {
    mockMigrationVersion = 1;
    mockBeginCalled = false;
    mockAdvisoryLockCalled = false;
    mockCommitCalled = false;

    const pool = new (await import('pg')).Pool();
    await createPostgresAdapter({ pool });

    expect(mockBeginCalled).toBe(true);
    expect(mockCommitCalled).toBe(true);
    // No error means migration ran successfully for version 1 (only v2 pending)
  });

  test('fails when db version exceeds binary max version', async () => {
    // MIGRATIONS.length is 2; anything > 2 should throw
    mockMigrationVersion = 3;

    const pool = new (await import('pg')).Pool();
    await expect(createPostgresAdapter({ pool })).rejects.toThrow(
      'Database schema version 3 is newer than this binary supports',
    );
  });

  test('fails on string version that exceeds max', async () => {
    mockMigrationVersion = '99';

    const pool = new (await import('pg')).Pool();
    await expect(createPostgresAdapter({ pool })).rejects.toThrow(
      'Database schema version 99 is newer than this binary supports (2)',
    );
  });

  test('fails on invalid version value from db', async () => {
    mockMigrationVersion = 'not-a-number';

    const pool = new (await import('pg')).Pool();
    await expect(createPostgresAdapter({ pool })).rejects.toThrow(
      '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: not-a-number',
    );
  });

  test('advisory lock is acquired during migration transaction', async () => {
    mockMigrationVersion = 0;
    mockAdvisoryLockCalled = false;

    const pool = new (await import('pg')).Pool();
    await createPostgresAdapter({ pool });

    expect(mockAdvisoryLockCalled).toBe(true);
  });

  test('skips migration when pool has assume-ready runtime', async () => {
    mockMigrationVersion = 0;
    mockConnectCount = 0;
    mockBeginCalled = false;

    const pool = new (await import('pg')).Pool();
    attachPostgresPoolRuntime(pool, createPostgresPoolRuntime({ migrationMode: 'assume-ready' }));
    await createPostgresAdapter({ pool });

    // pool.connect should NOT have been called (no migration transaction)
    expect(mockConnectCount).toBe(0);
    expect(mockBeginCalled).toBe(false);
  });
});

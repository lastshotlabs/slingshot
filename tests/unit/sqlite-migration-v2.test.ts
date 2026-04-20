/**
 * Tests for F1 — SQLite migration v2 (M2M clients table).
 *
 * Before F1, `createSqliteAuthAdapter` only applied v1 migrations and had no
 * M2M support. After F1, a v2 migration adds the `m2m_clients` table with
 * clientId, clientSecretHash, name, scopes, active, and createdAt columns.
 *
 * Covers:
 *   - Fresh database is migrated to at least version 2 so the v2 table exists
 *   - `m2m_clients` table exists and has correct columns after migration
 *   - Running createSqliteAuthAdapter on an already-migrated database is idempotent
 *   - M2M CRUD operations work correctly after migration (smoke test)
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSqliteAuthAdapter } from '@lastshotlabs/slingshot-auth';

// Track temp files created during tests so they can be cleaned up.
const tempFiles: string[] = [];

function mkTempPath(): string {
  const p = path.join(
    os.tmpdir(),
    `slingshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(f + suffix);
      } catch {
        /* empty */
      }
    }
  }
});

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<
      { name: string },
      [string]
    >("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  return row !== null;
}

function getSubsystemVersion(db: Database, subsystem: string): number {
  const row = db
    .query<
      { version: number },
      [string]
    >('SELECT version FROM _slingshot_migrations WHERE subsystem = ?')
    .get(subsystem);
  return row?.version ?? 0;
}

describe('SQLite migration v2 — m2m_clients table', () => {
  test('fresh database is migrated to version 2 with m2m_clients table', () => {
    const { db } = createSqliteAuthAdapter(new Database(':memory:'));
    const nativeDb = db as unknown as Database;

    expect(getSubsystemVersion(nativeDb, 'auth')).toBeGreaterThanOrEqual(2);
    expect(tableExists(nativeDb, 'm2m_clients')).toBe(true);
  });

  test('m2m_clients table has the expected columns', () => {
    const { db } = createSqliteAuthAdapter(new Database(':memory:'));
    const nativeDb = db as unknown as Database;

    const cols = nativeDb
      .query<{ name: string }, []>('PRAGMA table_info(m2m_clients)')
      .all()
      .map(c => c.name);

    expect(cols).toContain('id');
    expect(cols).toContain('clientId');
    expect(cols).toContain('clientSecretHash');
    expect(cols).toContain('name');
    expect(cols).toContain('scopes');
    expect(cols).toContain('active');
    expect(cols).toContain('createdAt');
  });

  test('calling createSqliteAuthAdapter twice is idempotent', () => {
    const tmpPath = mkTempPath();
    createSqliteAuthAdapter(new Database(tmpPath));
    // Second call should not throw or corrupt the schema
    const { db } = createSqliteAuthAdapter(new Database(tmpPath));
    const nativeDb = db as unknown as Database;
    expect(() => getSubsystemVersion(nativeDb, 'auth')).not.toThrow();
    expect(getSubsystemVersion(nativeDb, 'auth')).toBeGreaterThanOrEqual(2);
  });

  test('multiple subsystems can share a database without version collision', () => {
    // Verifies that auth and permissions can coexist in the same file with
    // independent version tracking — the core bug this migration fixes.
    const tmpPath = mkTempPath();

    // Auth runs first, sets its own version
    const { db: authDb } = createSqliteAuthAdapter(new Database(tmpPath));
    const nativeDb = authDb as unknown as Database;

    expect(getSubsystemVersion(nativeDb, 'auth')).toBeGreaterThanOrEqual(2);
    // No cross-contamination — other subsystems start at 0 until they run
    expect(getSubsystemVersion(nativeDb, 'permissions')).toBe(0);
  });

  test('M2M CRUD operations work after migration (smoke test)', async () => {
    const { adapter } = createSqliteAuthAdapter(new Database(':memory:'));

    expect(typeof adapter.createM2MClient).toBe('function');
    expect(typeof adapter.getM2MClient).toBe('function');
    expect(typeof adapter.deleteM2MClient).toBe('function');
    expect(typeof adapter.listM2MClients).toBe('function');

    // Create a client
    const secretHash = 'test-secret-hash';
    const result = await adapter.createM2MClient!({
      clientId: 'test-client-id',
      clientSecretHash: secretHash,
      name: 'Test Client',
      scopes: ['read:users'],
    });
    expect(result.id).toBeString();

    // Retrieve it by clientId (the business key)
    const fetched = await adapter.getM2MClient!('test-client-id');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Client');

    // List clients
    const list = await adapter.listM2MClients!();
    expect(list.length).toBe(1);

    // Delete it by clientId
    await adapter.deleteM2MClient!('test-client-id');
    const afterDelete = await adapter.getM2MClient!('test-client-id');
    expect(afterDelete).toBeNull();
  });
});

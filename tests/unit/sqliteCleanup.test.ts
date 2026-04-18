import { createSqliteAuthAdapter } from '@auth/adapters/sqliteAuth';
import type { SqliteAuthResult } from '@auth/adapters/sqliteAuth';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

// ---------------------------------------------------------------------------
// SQLite cleanup lifecycle tests
//
// The old setSqliteDb / stopSqliteCleanup / startSqliteCleanup module-level
// singletons have been removed. The factory function createSqliteAuthAdapter()
// now returns an object with startCleanup() and stopCleanup() methods that
// manage cleanup intervals via closure-owned state.
// ---------------------------------------------------------------------------

// Minimal resolved auth config for cleanup tests
const stubGetConfig = () =>
  ({
    sessionPolicy: { absoluteTimeout: 3600 },
  }) as any;

describe('SQLite cleanup lifecycle', () => {
  let result: SqliteAuthResult;

  afterEach(() => {
    result?.stopCleanup();
    result?.db?.close();
  });

  it('factory returns stopCleanup and startCleanup methods', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    expect(result.startCleanup).toBeFunction();
    expect(result.stopCleanup).toBeFunction();
  });

  it('stopCleanup is safe to call before startCleanup', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    // Should not throw even though cleanup was never started
    expect(() => result.stopCleanup()).not.toThrow();
  });

  it('startCleanup returns an interval handle', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    const handle = result.startCleanup(stubGetConfig, 60_000);
    expect(handle).toBeDefined();
  });

  it('stopCleanup is idempotent', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    result.startCleanup(stubGetConfig, 60_000);
    result.stopCleanup();
    result.stopCleanup(); // second call should not throw
  });

  it('startCleanup is idempotent — does not leak intervals', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    const handle1 = result.startCleanup(stubGetConfig, 60_000);
    const handle2 = result.startCleanup(stubGetConfig, 60_000);

    // Each call should return a new handle (old interval is cleared internally)
    expect(handle1).not.toBe(handle2);

    result.stopCleanup();
  });

  it('cleanupInterval is initially null on factory result', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    expect(result.cleanupInterval).toBeNull();
  });

  it('startCleanup runs one cleanup pass immediately', () => {
    result = createSqliteAuthAdapter(new Database(':memory:'));
    result.db.run(
      'INSERT INTO oauth_states (state, codeVerifier, linkUserId, expiresAt) VALUES (?, ?, ?, ?)',
      ['expired-state', 'verifier', null, Date.now() - 1_000],
    );

    result.startCleanup(stubGetConfig, 60_000);

    const nativeDb = result.db as unknown as Database;
    const remaining = nativeDb
      .query<
        { count: number },
        [string]
      >('SELECT COUNT(*) AS count FROM oauth_states WHERE state = ?')
      .get('expired-state');
    expect(remaining?.count ?? 0).toBe(0);
  });
});

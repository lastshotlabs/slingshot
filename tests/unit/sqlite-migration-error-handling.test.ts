import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createSqliteAuthAdapter } from '../../packages/slingshot-auth/src/adapters/sqliteAuth';
import { createSqliteMfaChallengeRepository } from '../../packages/slingshot-auth/src/lib/mfaChallenge';
import { createSqliteSessionRepository } from '../../packages/slingshot-auth/src/lib/session/sqliteStore';

function createInterceptedDb(
  db: Database,
  failForSql: (sql: string) => Error | null,
): RuntimeSqliteDatabase {
  const run = db.run.bind(db);
  return {
    run(sql: string, ...params: unknown[]) {
      const failure = failForSql(sql);
      if (failure) throw failure;
      return run(sql, ...params);
    },
    query: db.query.bind(db),
    prepare: db.prepare.bind(db),
    transaction: db.transaction.bind(db),
    close: db.close.bind(db),
  } as unknown as RuntimeSqliteDatabase;
}

describe('SQLite migration error handling', () => {
  test('auth migration v3 rethrows unexpected refresh-token scrub failures and does not advance the version', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE _slingshot_migrations (
        subsystem TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);
    db.run('INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)', ['auth', 2]);
    db.run(`
      CREATE TABLE sessions (
        sessionId TEXT PRIMARY KEY,
        refreshTokenPlain TEXT
      )
    `);

    const wrappedDb = createInterceptedDb(db, sql =>
      sql.includes('UPDATE sessions SET refreshTokenPlain = NULL')
        ? new Error('disk I/O error while scrubbing plaintext refresh tokens')
        : null,
    );

    expect(() => createSqliteAuthAdapter(wrappedDb)).toThrow(
      'disk I/O error while scrubbing plaintext refresh tokens',
    );

    const version = db
      .query<{ version: number }>('SELECT version FROM _slingshot_migrations WHERE subsystem = ?')
      .get('auth');
    expect(version?.version).toBe(2);
  });

  test('sqlite auth adapter fails closed when the database schema version is newer than this binary supports', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE _slingshot_migrations (
        subsystem TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);
    db.run('INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)', ['auth', 5]);

    expect(() => createSqliteAuthAdapter(db)).toThrow(
      "Subsystem 'auth' is at schema version 5, but this binary only supports up to version 4",
    );
  });

  test('sqlite session repository rethrows unexpected refresh-token cleanup errors during lazy init', async () => {
    const db = new Database(':memory:');
    const wrappedDb = createInterceptedDb(db, sql =>
      sql.includes('UPDATE sessions SET refreshTokenPlain = NULL')
        ? new Error('database disk image is malformed')
        : null,
    );
    const repo = createSqliteSessionRepository(wrappedDb);

    await expect(repo.createSession('user-1', 'jwt-1', 'session-1')).rejects.toThrow(
      'database disk image is malformed',
    );
  });

  test('sqlite MFA challenge repository rethrows unexpected column-migration failures', async () => {
    const db = new Database(':memory:');
    const wrappedDb = createInterceptedDb(db, sql =>
      sql.includes('ALTER TABLE mfa_challenges ADD COLUMN sessionId TEXT')
        ? new Error('database schema is locked')
        : null,
    );
    const repo = createSqliteMfaChallengeRepository(wrappedDb);

    await expect(
      repo.createChallenge(
        'token-1',
        {
          userId: 'user-1',
          purpose: 'login',
          createdAt: Date.now(),
          resendCount: 0,
        },
        300,
      ),
    ).rejects.toThrow('database schema is locked');
  });
});

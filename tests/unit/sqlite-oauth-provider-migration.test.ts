import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createSqliteAuthAdapter } from '@lastshotlabs/slingshot-auth';

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tableName);
  return row !== null;
}

describe('SQLite auth migration v4 — oauth_provider_links backfill', () => {
  test('fails loudly and rolls back when two users claim the same provider identity', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        providerIds TEXT NOT NULL DEFAULT '[]'
      )
    `);
    db.run(`
      CREATE TABLE _slingshot_migrations (
        subsystem TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);
    db.run('INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)', ['auth', 3]);
    db.run('INSERT INTO users (id, providerIds) VALUES (?, ?)', [
      'user-a',
      JSON.stringify(['google:dup']),
    ]);
    db.run('INSERT INTO users (id, providerIds) VALUES (?, ?)', [
      'user-b',
      JSON.stringify(['google:dup']),
    ]);

    expect(() => createSqliteAuthAdapter(db)).toThrow(
      /duplicate provider identities are claimed by multiple users/i,
    );

    const versionRow = db
      .query<{ version: number }, [string]>(
        'SELECT version FROM _slingshot_migrations WHERE subsystem = ?',
      )
      .get('auth');
    expect(versionRow?.version).toBe(3);
    expect(tableExists(db, 'oauth_provider_links')).toBe(false);
  });

  test('deduplicates repeated providerIds on the same user and backfills the new table', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        providerIds TEXT NOT NULL DEFAULT '[]'
      )
    `);
    db.run(`
      CREATE TABLE _slingshot_migrations (
        subsystem TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `);
    db.run('INSERT INTO _slingshot_migrations (subsystem, version) VALUES (?, ?)', ['auth', 3]);
    db.run('INSERT INTO users (id, providerIds) VALUES (?, ?)', [
      'user-a',
      JSON.stringify(['google:one', 'google:one', 'github:two']),
    ]);

    createSqliteAuthAdapter(db);

    const versionRow = db
      .query<{ version: number }, [string]>(
        'SELECT version FROM _slingshot_migrations WHERE subsystem = ?',
      )
      .get('auth');
    const users = db
      .query<{ providerIds: string }, []>('SELECT providerIds FROM users WHERE id = \'user-a\'')
      .get();
    const links = db
      .query<{ provider: string; providerUserId: string; userId: string }, []>(
        'SELECT provider, providerUserId, userId FROM oauth_provider_links ORDER BY provider, providerUserId',
      )
      .all();

    expect(versionRow?.version).toBe(4);
    expect(users?.providerIds).toBe(JSON.stringify(['github:two', 'google:one']));
    expect(links).toEqual([
      { provider: 'github', providerUserId: 'two', userId: 'user-a' },
      { provider: 'google', providerUserId: 'one', userId: 'user-a' },
    ]);
  });
});

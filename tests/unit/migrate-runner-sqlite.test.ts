/**
 * End-to-end coverage that the SQLite migration runner works UNDER BUN (#2).
 *
 * These tests run under Bun, so `loadSqliteDb` takes its new `bun:sqlite`
 * branch — the whole point of the fix. Before it, the runner unconditionally
 * imported `better-sqlite3`, whose native addon fails to load under Bun, so
 * `bunx slingshot migrate apply` could not run at all.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { applyPending, getStatus } from '../../src/cli/lib/migrate/runner';

describe('sqlite migration runner under Bun (#2)', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratch(): { root: string; dbPath: string; migrationsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'slingshot-migrate-runner-'));
    created.push(root);
    const migrationsDir = join(root, 'migrations');
    mkdirSync(join(migrationsDir, 'sqlite'), { recursive: true });
    return { root, dbPath: join(root, 'app.db'), migrationsDir };
  }

  function writeMigration(migrationsDir: string, id: string, sql: string): void {
    writeFileSync(join(migrationsDir, 'sqlite', `${id}.sql`), sql, 'utf8');
  }

  test('applies pending SQLite migrations and records them', async () => {
    const { dbPath, migrationsDir } = scratch();
    writeMigration(
      migrationsDir,
      '20260101000000_init',
      'CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL);',
    );

    const result = await applyPending({
      backend: 'sqlite',
      connectionString: dbPath,
      migrationsDir,
    });

    expect(result.applied.map(m => m.id)).toEqual(['20260101000000_init']);

    // The table really exists in the on-disk database.
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    try {
      const cols = db.query('PRAGMA table_info(widgets)').all() as { name: string }[];
      expect(cols.map(c => c.name).sort()).toEqual(['id', 'label']);
    } finally {
      db.close();
    }

    // Status now reports it as applied, nothing pending.
    const status = await getStatus({ backend: 'sqlite', connectionString: dbPath, migrationsDir });
    expect(status.applied.map(a => a.id)).toEqual(['20260101000000_init']);
    expect(status.pending).toHaveLength(0);
  });

  test('applying twice is idempotent — the second run has nothing to do', async () => {
    const { dbPath, migrationsDir } = scratch();
    writeMigration(migrationsDir, '20260101000000_init', 'CREATE TABLE t (id TEXT PRIMARY KEY);');

    await applyPending({ backend: 'sqlite', connectionString: dbPath, migrationsDir });
    const second = await applyPending({
      backend: 'sqlite',
      connectionString: dbPath,
      migrationsDir,
    });

    expect(second.applied).toHaveLength(0);
  });
});

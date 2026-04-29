import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '../src/index';

describe('sqlite', () => {
  test('file-based database opens in WAL journal mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-wal-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'wal-test.db'));
      const result = db.query<{ journal_mode: string }>('PRAGMA journal_mode').get();
      expect(result).not.toBeNull();
      expect(result!.journal_mode.toLowerCase()).toBe('wal');
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('in-memory database works without WAL mode check', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('INSERT INTO t VALUES (42)');
    const row = db.query<{ x: number }>('SELECT x FROM t').get();
    expect(row?.x).toBe(42);
    db.close();
  });

  test('transaction commits all changes on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-tx-commit-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'tx-commit.db'));
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');

      const txn = db.transaction(() => {
        db.run('INSERT INTO items (label) VALUES (?)', 'alpha');
        db.run('INSERT INTO items (label) VALUES (?)', 'beta');
      });
      txn();

      const count = db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM items').get();
      expect(count?.cnt).toBe(2);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('transaction rolls back all changes on throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-tx-rollback-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'tx-rollback.db'));
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');

      const failing = db.transaction(() => {
        db.run('INSERT INTO items (label) VALUES (?)', 'will-rollback');
        throw new Error('force-rollback');
      });

      expect(() => failing()).toThrow('force-rollback');
      const count = db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM items').get();
      expect(count?.cnt).toBe(0);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('nested successful transactions use savepoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-savepoint-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'savepoint.db'));
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');

      const outer = db.transaction(() => {
        db.run('INSERT INTO items (label) VALUES (?)', 'outer');
        const inner = db.transaction(() => {
          db.run('INSERT INTO items (label) VALUES (?)', 'inner');
        });
        inner();
      });
      outer();

      const rows = db.query<{ label: string }>('SELECT label FROM items ORDER BY id').all();
      expect(rows.map(r => r.label)).toEqual(['outer', 'inner']);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('nested transaction rollback rolls back inner savepoint but outer still commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-savepoint-rb-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'savepoint-rb.db'));
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');

      const outer = db.transaction(() => {
        db.run('INSERT INTO items (label) VALUES (?)', 'outer');
        const inner = db.transaction(() => {
          db.run('INSERT INTO items (label) VALUES (?)', 'inner');
          throw new Error('inner-rollback');
        });
        try {
          inner();
        } catch {
          /* expected -- inner savepoint rolled back */
        }
      });
      outer();

      const rows = db.query<{ label: string }>('SELECT label FROM items ORDER BY id').all();
      // outer commit should survive the inner savepoint rollback
      expect(rows.map(r => r.label)).toEqual(['outer']);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('prepared statement works inside a transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-prep-tx-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'prep-tx.db'));
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');

      const insert = db.prepare('INSERT INTO items (label) VALUES (?)');
      const txn = db.transaction(() => {
        insert.run('via-prep-a');
        insert.run('via-prep-b');
      });
      txn();

      const rows = db.query<{ label: string }>('SELECT label FROM items ORDER BY id').all();
      expect(rows.map(r => r.label)).toEqual(['via-prep-a', 'via-prep-b']);

      // Verify prepared statement still works outside transaction
      const read = db.prepare<{ label: string }>('SELECT label FROM items ORDER BY id');
      const all = read.all();
      expect(all).toHaveLength(2);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('prepared statement get returns null for missing row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-prep-null-'));
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const db = runtime.sqlite.open(join(dir, 'prep-null.db'));
      db.run('CREATE TABLE t (x TEXT)');

      const stmt = db.prepare<{ x: string }>('SELECT x FROM t WHERE x = ?');
      expect(stmt.get('missing')).toBeNull();

      db.run("INSERT INTO t VALUES ('present')");
      expect(stmt.get('present')?.x).toBe('present');
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('query get returns null for no match', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    const result = db.query<{ x: number }>('SELECT x FROM t WHERE x = 999').get();
    expect(result).toBeNull();
    db.close();
  });

  test('close prevents further queries', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.close();
    expect(() => db.run('SELECT 1')).toThrow();
  });
});

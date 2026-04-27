import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../../src/index';

// Tests for runtime.sqlite (better-sqlite3) run under bun:test.
// WebSocket upgrade flow tests are exercised via the smoke test server tests.

describe('runtime.sqlite', () => {
  // ---------------------------------------------------------------------------
  // open()
  // ---------------------------------------------------------------------------

  test('open() returns a RuntimeSqliteDatabase for an in-memory database', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      expect(typeof db.run).toBe('function');
      expect(typeof db.query).toBe('function');
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.transaction).toBe('function');
      expect(typeof db.close).toBe('function');
    } finally {
      db.close();
    }
  });

  test('open() returns a RuntimeSqliteDatabase for a temp file database', () => {
    const runtime = nodeRuntime();
    const path = join(tmpdir(), `slingshot-sqlite-open-${Date.now()}.db`);
    const db = runtime.sqlite.open(path);

    try {
      expect(typeof db.run).toBe('function');
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Prepared statements and basic DML
  // ---------------------------------------------------------------------------

  test('run() executes DDL and DML without returning rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      db.run('INSERT INTO items (name) VALUES (?)', 'alpha');
      db.run('INSERT INTO items (name) VALUES (?)', 'beta');

      type Row = { id: number; name: string };
      const rows = db.query<Row>('SELECT * FROM items ORDER BY id').all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: 1, name: 'alpha' });
      expect(rows[1]).toEqual({ id: 2, name: 'beta' });
    } finally {
      db.close();
    }
  });

  test('query().get() returns the first row or null when no rows match', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
      db.run('INSERT INTO kv VALUES (?, ?)', 'hello', 'world');

      type Row = { key: string; value: string };
      const found = db.query<Row>('SELECT * FROM kv WHERE key = ?').get('hello');
      expect(found).toEqual({ key: 'hello', value: 'world' });

      const missing = db.query<Row>('SELECT * FROM kv WHERE key = ?').get('nope');
      expect(missing).toBeNull();
    } finally {
      db.close();
    }
  });

  test('prepare().run() returns a RunResult with the number of changed rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER DEFAULT 0)');
      db.run('INSERT INTO counters (n) VALUES (?)', 10);
      db.run('INSERT INTO counters (n) VALUES (?)', 20);

      const stmt = db.prepare('UPDATE counters SET n = n + 1 WHERE n < ?');
      const result = stmt.run(15);
      expect(result.changes).toBe(1);
    } finally {
      db.close();
    }
  });

  test('prepare().get() and prepare().all() return typed rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)');
      db.run('INSERT INTO tags (label) VALUES (?)', 'a');
      db.run('INSERT INTO tags (label) VALUES (?)', 'b');
      db.run('INSERT INTO tags (label) VALUES (?)', 'c');

      type Row = { id: number; label: string };
      const stmt = db.prepare<Row>('SELECT * FROM tags WHERE id > ? ORDER BY id');

      const first = stmt.get(1);
      expect(first).toEqual({ id: 2, label: 'b' });

      const all = stmt.all(0);
      expect(all).toHaveLength(3);
      expect(all.map(r => r.label)).toEqual(['a', 'b', 'c']);
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  test('transaction() commits all writes atomically on success', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER)');

      const transfer = db.transaction(() => {
        db.run('INSERT INTO ledger (amount) VALUES (?)', 100);
        db.run('INSERT INTO ledger (amount) VALUES (?)', -100);
      });

      transfer();

      type Row = { amount: number };
      const rows = db.query<Row>('SELECT amount FROM ledger ORDER BY id').all();
      expect(rows).toHaveLength(2);
      expect(rows[0].amount + rows[1].amount).toBe(0);
    } finally {
      db.close();
    }
  });

  test('transaction() rolls back all writes when the function throws', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER)');

      const failingTransfer = db.transaction(() => {
        db.run('INSERT INTO ledger (amount) VALUES (?)', 50);
        throw new Error('simulated failure');
      });

      expect(() => failingTransfer()).toThrow('simulated failure');

      type Row = { amount: number };
      const rows = db.query<Row>('SELECT amount FROM ledger').all();
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Concurrent handles (no deadlock)
  // ---------------------------------------------------------------------------

  test('two handles on the same in-memory path do not deadlock each other', () => {
    // Each call to open(':memory:') with better-sqlite3 creates a separate
    // private in-memory database. This verifies that opening multiple handles
    // does not cause a deadlock or block.
    const runtime = nodeRuntime();

    const db1 = runtime.sqlite.open(':memory:');
    const db2 = runtime.sqlite.open(':memory:');

    try {
      db1.run('CREATE TABLE t (v INTEGER)');
      db2.run('CREATE TABLE t (v INTEGER)');

      db1.run('INSERT INTO t VALUES (?)', 1);
      db2.run('INSERT INTO t VALUES (?)', 2);

      type Row = { v: number };
      expect(db1.query<Row>('SELECT v FROM t').get()).toEqual({ v: 1 });
      expect(db2.query<Row>('SELECT v FROM t').get()).toEqual({ v: 2 });
    } finally {
      db1.close();
      db2.close();
    }
  });

  test('two handles on the same file-based path can each read and write', () => {
    const runtime = nodeRuntime();
    const path = join(tmpdir(), `slingshot-sqlite-concurrent-${Date.now()}.db`);

    const db1 = runtime.sqlite.open(path);
    db1.run('CREATE TABLE shared (id INTEGER PRIMARY KEY, val TEXT)');
    db1.run('INSERT INTO shared VALUES (?, ?)', 1, 'from-db1');

    const db2 = runtime.sqlite.open(path);

    try {
      type Row = { id: number; val: string };
      const row = db2.query<Row>('SELECT * FROM shared WHERE id = ?').get(1);
      expect(row).toEqual({ id: 1, val: 'from-db1' });

      db2.run('INSERT INTO shared VALUES (?, ?)', 2, 'from-db2');
      const all = db1.query<Row>('SELECT * FROM shared ORDER BY id').all();
      expect(all).toHaveLength(2);
      expect(all[1].val).toBe('from-db2');
    } finally {
      db1.close();
      db2.close();
    }
  });
});

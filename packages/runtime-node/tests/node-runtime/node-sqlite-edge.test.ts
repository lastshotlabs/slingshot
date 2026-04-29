import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { nodeRuntime } from '../../src/index';

void describe;
void expect;

describe('runtime.sqlite — concurrent queries', () => {
  test('multiple concurrent queries on the same database', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER)');
      for (let i = 0; i < 100; i++) {
        db.run('INSERT INTO t VALUES (?, ?)', i, i * 2);
      }

      const all = db.query('SELECT COUNT(*) AS cnt FROM t').all() as Array<{ cnt: number }>;
      expect(all[0]?.cnt).toBe(100);

      const sum = db.query('SELECT SUM(val) AS total FROM t').all() as Array<{ total: number }>;
      // sum of i*2 for i=0..99 = 2 * (99*100/2) = 9900
      expect(sum[0]?.total).toBe(9900);
    } finally {
      db.close();
    }
  });

  test('query with bound parameters', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, count INTEGER)');
      db.run('INSERT INTO items VALUES (1, ?, ?)', 'alpha', 10);
      db.run('INSERT INTO items VALUES (2, ?, ?)', 'beta', 20);
      db.run('INSERT INTO items VALUES (3, ?, ?)', 'gamma', 30);

      const found = db.query('SELECT * FROM items WHERE count > ?').all(15) as Array<{
        label: string;
        count: number;
      }>;
      expect(found).toHaveLength(2);
      expect(found.map(r => r.label).sort()).toEqual(['beta', 'gamma']);

      const single = db.query('SELECT * FROM items WHERE label = ?').get('alpha') as {
        label: string;
        count: number;
      } | null;
      expect(single).not.toBeNull();
      expect(single!.count).toBe(10);
    } finally {
      db.close();
    }
  });

  test('null and undefined parameter handling', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      db.run('INSERT INTO t VALUES (1, ?)', null);
      db.run('INSERT INTO t VALUES (2, ?)', 'not-null');

      const rows = db.query('SELECT * FROM t ORDER BY id').all() as Array<{
        id: number;
        val: string | null;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.val).toBeNull();
      expect(rows[1]?.val).toBe('not-null');
    } finally {
      db.close();
    }
  });
});

describe('runtime.sqlite — table operations', () => {
  test('INSERT OR REPLACE works', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      db.run('INSERT INTO t VALUES (1, ?)', 'original');
      db.run('INSERT OR REPLACE INTO t VALUES (1, ?)', 'replaced');

      const row = db.query('SELECT val FROM t WHERE id = 1').get() as { val: string } | null;
      expect(row?.val).toBe('replaced');
    } finally {
      db.close();
    }
  });

  test('DELETE removes rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.run('INSERT INTO t VALUES (1)');
      db.run('INSERT INTO t VALUES (2)');
      db.run('DELETE FROM t WHERE id = 1');

      const rows = db.query('SELECT id FROM t').all() as Array<{ id: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    } finally {
      db.close();
    }
  });

  test('multiple tables in same database', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(':memory:');

    try {
      db.run('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
      db.run('CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT)');
      db.run('INSERT INTO a VALUES (1, ?)', 'from-a');
      db.run('INSERT INTO b VALUES (1, ?)', 'from-b');

      const a = db.query('SELECT v FROM a WHERE id = 1').get() as { v: string } | null;
      const b = db.query('SELECT v FROM b WHERE id = 1').get() as { v: string } | null;
      expect(a?.v).toBe('from-a');
      expect(b?.v).toBe('from-b');
    } finally {
      db.close();
    }
  });
});

describe('runtime.sqlite — database file operations', () => {
  test('creating a file-based database and querying it', () => {
    const runtime = nodeRuntime();
    const path = join(tmpdir(), `slingshot-sqlite-edge-${Date.now()}.db`);

    const db = runtime.sqlite.open(path);
    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      db.run('INSERT INTO t VALUES (1, ?)', 'file-based');
      const row = db.query('SELECT val FROM t WHERE id = 1').get() as { val: string } | null;
      expect(row?.val).toBe('file-based');
    } finally {
      db.close();
    }
  });

  test('opening a file database twice (separate handles)', () => {
    const runtime = nodeRuntime();
    const path = join(tmpdir(), `slingshot-sqlite-dual-${Date.now()}.db`);

    const db1 = runtime.sqlite.open(path);
    db1.run('CREATE TABLE shared (id INTEGER PRIMARY KEY, msg TEXT)');
    db1.run('INSERT INTO shared VALUES (1, ?)', 'from-db1');

    const db2 = runtime.sqlite.open(path);
    try {
      const row = db2.query('SELECT msg FROM shared WHERE id = 1').get() as { msg: string } | null;
      expect(row?.msg).toBe('from-db1');
    } finally {
      db1.close();
      db2.close();
    }
  });
});

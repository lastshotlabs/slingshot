import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import { createPostgresEntityAdapter } from '../../src/configDriven/postgresAdapter';
import { createSqliteEntityAdapter } from '../../src/configDriven/sqliteAdapter';
import { collectionSqlite } from '../../src/configDriven/operationExecutors/collection';
import { generatePostgres } from '../../src/generators/postgres';
import { generateSqlite } from '../../src/generators/sqlite';

function createSqliteWrapper(
  raw: Database,
  onRun?: (sql: string, params?: unknown[]) => void,
): {
  run(sql: string, params?: unknown[]): { changes: number };
  query<T>(sql: string): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] };
} {
  return {
    run(sql: string, params?: unknown[]) {
      onRun?.(sql, params);
      if (params === undefined) {
        return raw.run(sql) as { changes: number };
      }
      return raw.run(sql, params as never) as { changes: number };
    },
    query<T>(sql: string) {
      const stmt = raw.query(sql);
      return {
        get(...args: unknown[]) {
          return stmt.get(...(args as never[])) as T | null;
        },
        all(...args: unknown[]) {
          return stmt.all(...(args as never[])) as T[];
        },
      };
    },
  };
}

describe('entity bootstrap hardening', () => {
  test('sqlite entity bootstrap rolls back and retries after schema-init failure', async () => {
    const Widget = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true }),
        slug: field.string(),
      },
      indexes: [{ fields: ['slug'] }],
    });

    const calls: string[] = [];
    let failIndex = true;
    const db = {
      run(sql: string, params?: unknown[]) {
        const normalized = sql.trim();
        calls.push(normalized);
        if (failIndex && normalized.includes('CREATE INDEX IF NOT EXISTS idx_widgets_0')) {
          failIndex = false;
          throw new Error('index bootstrap failed');
        }
        return { changes: normalized.startsWith('INSERT OR REPLACE INTO') ? 1 : 0 };
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
    };

    const adapter = createSqliteEntityAdapter(db as never, Widget);

    expect(() => adapter.create({ id: 'w1', slug: 'alpha' } as never)).toThrow(
      'index bootstrap failed',
    );
    expect(calls).toContain('PRAGMA busy_timeout = 5000');
    expect(calls).toContain('BEGIN IMMEDIATE');
    expect(calls).toContain('ROLLBACK');
    expect(calls.some(sql => sql.startsWith('INSERT OR REPLACE INTO widgets'))).toBe(false);

    calls.length = 0;
    await adapter.create({ id: 'w1', slug: 'alpha' } as never);

    expect(calls[0]).toBe('PRAGMA busy_timeout = 5000');
    expect(calls[1]).toBe('BEGIN IMMEDIATE');
    expect(calls).toContain('COMMIT');
    expect(calls.some(sql => sql.startsWith('INSERT OR REPLACE INTO widgets'))).toBe(true);
  });

  test('postgres entity bootstrap runs inside a transaction and retries after failure', async () => {
    const Widget = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true }),
        slug: field.string(),
      },
      indexes: [{ fields: ['slug'] }],
    });

    const clientQueries: string[] = [];
    const poolQueries: string[] = [];
    let failIndex = true;

    const client = {
      async query(sql: string) {
        clientQueries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (failIndex && sql.includes('CREATE INDEX IF NOT EXISTS idx_slingshot_widgets_0')) {
          failIndex = false;
          throw new Error('index bootstrap failed');
        }
        if (
          sql.startsWith('CREATE TABLE IF NOT EXISTS') ||
          sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
          sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS')
        ) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unhandled client SQL: ${sql}`);
      },
      release() {},
    };

    const pool = {
      async connect() {
        return client;
      },
      async query(sql: string) {
        poolQueries.push(sql);
        if (sql.startsWith('INSERT INTO slingshot_widgets')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unhandled pool SQL: ${sql}`);
      },
    };

    const adapter = createPostgresEntityAdapter(pool as never, Widget);

    await expect(adapter.create({ id: 'w1', slug: 'alpha' } as never)).rejects.toThrow(
      'index bootstrap failed',
    );
    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('ROLLBACK');
    expect(poolQueries).toEqual([]);

    clientQueries.length = 0;
    await adapter.create({ id: 'w1', slug: 'alpha' } as never);

    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('COMMIT');
    expect(poolQueries.some(sql => sql.startsWith('INSERT INTO slingshot_widgets'))).toBe(true);
  });

  test('sqlite collection set is atomic across delete plus insert rewrite', async () => {
    const Parent = defineEntity('Parent', {
      fields: {
        id: field.string({ primary: true }),
      },
    });

    const raw = new Database(':memory:');
    const db = createSqliteWrapper(raw, (sql, params) => {
      if (
        sql.startsWith('INSERT INTO parent_table_items') &&
        Array.isArray(params) &&
        params[2] === 'bad'
      ) {
        throw new Error('insert failed');
      }
    });

    const collection = collectionSqlite(
      'items',
      {
        kind: 'collection',
        parentKey: 'parentId',
        itemFields: {
          id: field.string(),
          label: field.string(),
        },
        operations: ['set'],
        identifyBy: 'id',
      },
      Parent,
      db as never,
      'parent_table',
      () => {},
    );

    if (!collection.set) {
      throw new Error('expected collection.set to be defined');
    }

    await collection.set('p1', [{ id: 'existing', label: 'Existing' }]);

    expect(() =>
      collection.set?.('p1', [
        { id: 'ok', label: 'Ok' },
        { id: 'bad', label: 'bad' },
      ]),
    ).toThrow('insert failed');

    const rows = raw
      .query<{ id: string; label: string }, [string]>(
        'SELECT id, label FROM parent_table_items WHERE parent_id = ? ORDER BY id ASC',
      )
      .all('p1');

    expect(rows).toEqual([{ id: 'existing', label: 'Existing' }]);
  });

  test('sqlite collection bootstrap does not nest transactions when parent bootstrap is cold', async () => {
    const Parent = defineEntity('Parent', {
      fields: {
        id: field.string({ primary: true }),
      },
    });

    const raw = new Database(':memory:');
    const db = createSqliteWrapper(raw);
    let parentInitialized = false;

    const collection = collectionSqlite(
      'items',
      {
        kind: 'collection',
        parentKey: 'parentId',
        itemFields: {
          id: field.string(),
          label: field.string(),
        },
        operations: ['set'],
        identifyBy: 'id',
      },
      Parent,
      db as never,
      'parent_table',
      () => {
        if (parentInitialized) return;
        db.run('PRAGMA busy_timeout = 5000');
        db.run('BEGIN IMMEDIATE');
        try {
          db.run('CREATE TABLE IF NOT EXISTS parent_table (id TEXT PRIMARY KEY)');
          db.run('COMMIT');
          parentInitialized = true;
        } catch (error) {
          db.run('ROLLBACK');
          throw error;
        }
      },
    );

    if (!collection.set) {
      throw new Error('expected collection.set to be defined');
    }

    await collection.set('p1', [{ id: 'child-1', label: 'Child' }]);

    const parentRows = raw
      .query<{ id: string }, []>('SELECT id FROM parent_table')
      .all();
    const childRows = raw
      .query<{ id: string; label: string }, [string]>(
        'SELECT id, label FROM parent_table_items WHERE parent_id = ?',
      )
      .all('p1');

    expect(parentRows).toEqual([]);
    expect(childRows).toEqual([{ id: 'child-1', label: 'Child' }]);
  });

  test('generated sqlite and postgres adapters emit hardened bootstrap logic', () => {
    const Widget = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true }),
        slug: field.string(),
      },
      indexes: [{ fields: ['slug'] }],
    });

    const sqliteSource = generateSqlite(Widget);
    expect(sqliteSource).toContain("db.run('PRAGMA busy_timeout = 5000');");
    expect(sqliteSource).toContain("db.run('BEGIN IMMEDIATE');");
    expect(sqliteSource).toContain("db.run('COMMIT');");
    expect(sqliteSource).toContain("db.run('ROLLBACK');");

    const postgresSource = generatePostgres(Widget);
    expect(postgresSource).toContain('let initializationPromise: Promise<void> | null = null;');
    expect(postgresSource).toContain('const client = await pool.connect();');
    expect(postgresSource).toContain("await client.query('BEGIN');");
    expect(postgresSource).toContain("await client.query('COMMIT');");
    expect(postgresSource).toContain("await client.query('ROLLBACK');");
  });
});

import { describe, expect, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import { createPostgresEntityAdapter } from '../../src/configDriven/postgresAdapter';

type PgRow = Record<string, unknown>;

class FakeListFilterPool {
  readonly queries: string[] = [];
  private readonly rows: PgRow[] = [];

  query(sql: string, params: unknown[] = []): Promise<{ rows: PgRow[]; rowCount: number | null }> {
    this.queries.push(sql);

    if (
      sql.startsWith('CREATE TABLE IF NOT EXISTS') ||
      sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
      sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS')
    ) {
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith('INSERT INTO notes_table (')) {
      const match = /^INSERT INTO [^(]+\(([^)]+)\) VALUES/.exec(sql);
      if (!match?.[1]) {
        throw new Error(`Unable to parse insert columns: ${sql}`);
      }

      const row: PgRow = {};
      const columns = match[1].split(',').map(column => column.trim());
      for (let i = 0; i < columns.length; i++) {
        row[columns[i] ?? `col_${i}`] = params[i];
      }
      this.rows.push(row);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    if (sql === 'SELECT * FROM notes_table WHERE owner_id = $1 ORDER BY id ASC LIMIT $2') {
      const ownerId = String(params[0]);
      const limit = Number(params[1]);
      const filteredRows = this.rows
        .filter(row => String(row.owner_id) === ownerId)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .slice(0, limit)
        .map(row => ({ ...row }));
      return Promise.resolve({ rows: filteredRows, rowCount: filteredRows.length });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

describe('createPostgresEntityAdapter list filter handling', () => {
  test('supports nested list({ filter }) bindings used by CRUD dataScope', async () => {
    const Note = defineEntity('Note', {
      namespace: 'test',
      storage: {
        postgres: { tableName: 'notes_table' },
      },
      fields: {
        id: field.string({ primary: true }),
        ownerId: field.string(),
        title: field.string(),
      },
    });

    const pool = new FakeListFilterPool();
    const adapter = createPostgresEntityAdapter<
      { id: string; ownerId: string; title: string },
      { id: string; ownerId: string; title: string },
      { title?: string }
    >(pool, Note);

    await adapter.create({ id: 'note-1', ownerId: 'user-1', title: 'Visible' });
    await adapter.create({ id: 'note-2', ownerId: 'user-2', title: 'Hidden' });

    const result = await adapter.list({ filter: { ownerId: 'user-1' } });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: 'note-1',
      ownerId: 'user-1',
      title: 'Visible',
    });
    expect(pool.queries).toContain(
      'SELECT * FROM notes_table WHERE owner_id = $1 ORDER BY id ASC LIMIT $2',
    );
  });
});

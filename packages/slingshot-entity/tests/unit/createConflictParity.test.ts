import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { HttpError, defineEntity, field } from '@lastshotlabs/slingshot-core';
import { createMemoryEntityAdapter } from '../../src/configDriven/memoryAdapter';
import { createPostgresEntityAdapter } from '../../src/configDriven/postgresAdapter';
import { createSqliteEntityAdapter } from '../../src/configDriven/sqliteAdapter';

type Doc = { id: string; slug: string };
type PgRow = Record<string, unknown>;

const DocEntity = defineEntity('ConflictParityDoc', {
  namespace: 'test',
  storage: { postgres: { tableName: 'conflict_parity_docs' } },
  fields: {
    id: field.string({ primary: true }),
    slug: field.string(),
  },
  indexes: [{ fields: ['slug'], unique: true }],
});

class ConflictPostgresPool {
  readonly rows: PgRow[] = [];
  readonly inserts: string[] = [];

  query(sql: string, params: unknown[] = []): Promise<{ rows: PgRow[]; rowCount: number | null }> {
    if (
      sql.startsWith('CREATE TABLE IF NOT EXISTS') ||
      sql.startsWith('ALTER TABLE') ||
      sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
      sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS')
    ) {
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith('INSERT INTO conflict_parity_docs (')) {
      this.inserts.push(sql);
      const columns = /^INSERT INTO [^(]+\(([^)]+)\) VALUES/.exec(sql)?.[1]?.split(', ');
      if (!columns) throw new Error(`Unable to parse insert: ${sql}`);
      const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      if (this.rows.some(existing => existing.id === row.id || existing.slug === row.slug)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      }
      this.rows.push(row);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    if (sql === 'SELECT * FROM conflict_parity_docs WHERE id = $1 LIMIT 1') {
      const row = this.rows.find(entry => entry.id === params[0]);
      return Promise.resolve({ rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

async function expectConflict(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({
    status: 409,
    code: 'UNIQUE_VIOLATION',
  } satisfies Partial<HttpError>);
}

describe('create() conflict parity across entity adapters', () => {
  test('primary-key and secondary unique conflicts reject without replacing the original row', async () => {
    const sqlite = new Database(':memory:');
    const postgresPool = new ConflictPostgresPool();
    const adapters = [
      createMemoryEntityAdapter<Doc, Doc, Partial<Doc>>(DocEntity),
      createSqliteEntityAdapter<Doc, Doc, Partial<Doc>>(sqlite, DocEntity),
      createPostgresEntityAdapter<Doc, Doc, Partial<Doc>>(postgresPool, DocEntity),
    ];

    try {
      for (const adapter of adapters) {
        await adapter.create({ id: 'A', slug: 'original' });
        await expectConflict(adapter.create({ id: 'A', slug: 'replacement' }));
        await expectConflict(adapter.create({ id: 'B', slug: 'original' }));
        expect(await adapter.getById('A')).toEqual({ id: 'A', slug: 'original' });
        expect(await adapter.getById('B')).toBeNull();
      }

      expect(postgresPool.inserts).not.toHaveLength(0);
      expect(postgresPool.inserts.every(sql => !sql.includes('ON CONFLICT'))).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

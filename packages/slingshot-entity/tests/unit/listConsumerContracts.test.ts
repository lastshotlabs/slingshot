import { describe, expect, test } from 'bun:test';
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { createMemoryEntityAdapter } from '../../src/configDriven/memoryAdapter';
import { generateMemory } from '../../src/generators/memory';
import { generateMongo } from '../../src/generators/mongo';
import { generatePostgres } from '../../src/generators/postgres';
import { generateRedis } from '../../src/generators/redis';
import { generateSqlite } from '../../src/generators/sqlite';
import { generateInitialMigrationPostgres } from '../../src/migrations/generators/initial';

const FeedItem = defineEntity('FeedItem', {
  fields: {
    id: field.string({ primary: true }),
    tenantId: field.string({ optional: true }),
    authorId: field.string(),
    status: field.string(),
    score: field.integer(),
    createdAt: field.date(),
  },
  indexes: [index(['authorId']), index(['status', 'tenantId'], { unique: true })],
  pagination: {
    cursor: { fields: ['id'] },
    defaultLimit: 2,
    maxLimit: 4,
  },
  defaultSort: { field: 'createdAt', direction: 'desc' },
});

interface FeedRecord {
  id: string;
  tenantId?: string;
  authorId: string;
  status: string;
  score: number;
  createdAt: Date;
}

describe('consumer-facing list contracts', () => {
  test('defaultSort.field leads pagination and the primary key is a stable tiebreaker', async () => {
    const adapter = createMemoryEntityAdapter<FeedRecord, FeedRecord, Partial<FeedRecord>>(
      FeedItem,
    );
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    await adapter.create({
      id: 'z',
      tenantId: 'tenant-z',
      authorId: 'a',
      status: 'published',
      score: 1,
      createdAt: new Date('2026-07-30T10:00:00.000Z'),
    });
    await adapter.create({
      id: 'b',
      tenantId: 'tenant-b',
      authorId: 'b',
      status: 'published',
      score: 2,
      createdAt,
    });
    await adapter.create({
      id: 'a',
      tenantId: 'tenant-a',
      authorId: 'c',
      status: 'draft',
      score: 3,
      createdAt,
    });

    const first = await adapter.list({ limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['b', 'a']);
    expect(first.hasMore).toBe(true);

    const second = await adapter.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map(item => item.id)).toEqual(['z']);
    expect(second.hasMore).toBe(false);
  });

  test('nested set, comparison, and OR filters execute in one list call', async () => {
    const adapter = createMemoryEntityAdapter<FeedRecord, FeedRecord, Partial<FeedRecord>>(
      FeedItem,
    );
    for (const [id, authorId, status, score] of [
      ['a', 'u1', 'published', 1],
      ['b', 'u2', 'draft', 5],
      ['c', 'u3', 'hidden', 10],
    ] as const) {
      await adapter.create({
        id,
        tenantId: `tenant-${id}`,
        authorId,
        status,
        score,
        createdAt: new Date(),
      });
    }

    const result = await adapter.list({
      limit: 4,
      filter: {
        authorId: { $in: ['u1', 'u2', 'missing'] },
        $or: [{ status: 'published' }, { score: { $gte: 5 } }],
      },
    });

    expect(result.items.map(item => item.id).sort()).toEqual(['a', 'b']);
  });

  test('every generated backend carries the loud limit and effective-sort contracts', () => {
    const sources = [
      generateMemory(FeedItem),
      generateRedis(FeedItem),
      generateSqlite(FeedItem),
      generatePostgres(FeedItem),
      generateMongo(FeedItem),
    ];

    for (const source of sources) {
      expect(source).toContain('rawLimit > 4');
      expect(source).toContain("'createdAt', 'id'");
      expect(source).toContain('resolveListFilter');
    }
    expect(generatePostgres(FeedItem)).toContain("if ('$in' in op || '$nin' in op)");
    expect(generateSqlite(FeedItem)).toContain("if ('$in' in op || '$nin' in op)");
    expect(generateMongo(FeedItem)).toContain('buildMongoListFilter');
  });

  test('the generated adapter sources remain syntactically valid TypeScript', async () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    for (const source of [
      generateMemory(FeedItem),
      generateRedis(FeedItem),
      generateSqlite(FeedItem),
      generatePostgres(FeedItem),
      generateMongo(FeedItem),
    ]) {
      await expect(transpiler.transform(source)).resolves.toBeString();
    }
  });

  test('Postgres index DDL is definition-derived and null-safe for tenant composites', () => {
    const runtime = generatePostgres(FeedItem);
    expect(runtime).toContain('idx_slingshot_feed_items_author_id');
    expect(runtime).toContain('idx_slingshot_feed_items_status_tenant_id');
    expect(runtime).toContain('(status, tenant_id) NULLS NOT DISTINCT');
    expect(runtime).toContain('DROP INDEX IF EXISTS idx_${table}_1');

    const migration = generateInitialMigrationPostgres(FeedItem);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_slingshot_feed_items_status_tenant_id" ON "slingshot_feed_items" ("status", "tenant_id") NULLS NOT DISTINCT;',
    );
  });
});

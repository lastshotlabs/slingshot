import { describe, expect, test } from 'bun:test';
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { createPostgresEntityAdapter } from '../../src/configDriven/postgresAdapter';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

describe('config-driven Postgres schema hardening', () => {
  test('rebuilds a positional index whose definition drifted', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT indexdef FROM pg_indexes')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: sql.startsWith('INSERT') ? 1 : 0 };
      },
    };
    const Reaction = defineEntity('Reaction', {
      namespace: 'community',
      storage: { postgres: { tableName: 'community_reactions' } },
      fields: {
        id: field.string({ primary: true }),
        targetId: field.string(),
        targetType: field.string(),
        userId: field.string(),
        value: field.string(),
      },
      indexes: [index(['targetId', 'targetType', 'userId', 'value'], { unique: true })],
    });

    await createPostgresEntityAdapter(pool, Reaction).create({
      id: 'r1',
      targetId: 'post-1',
      targetType: 'post',
      userId: 'user-1',
      value: 'laugh',
    });

    expect(queries.map(query => query.sql)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_community_reactions_target_id_target_type_user_id_value" ON community_reactions ("target_id", "target_type", "user_id", "value")',
    );
    expect(queries.map(query => query.sql)).toContain(
      'DROP INDEX IF EXISTS "idx_community_reactions_0"',
    );
  });

  test('quotes reserved-word field names in runtime writes', async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string): Promise<QueryResult> {
        queries.push(sql);
        return { rows: [], rowCount: sql.startsWith('INSERT') ? 1 : 0 };
      },
    };
    const Item = defineEntity('Item', {
      namespace: 'trip',
      storage: { postgres: { tableName: 'itinerary_items' } },
      fields: {
        id: field.string({ primary: true }),
        order: field.integer(),
      },
    });

    await createPostgresEntityAdapter(pool, Item).create({ id: 'i1', order: 1 });

    expect(queries).toContain('INSERT INTO itinerary_items ("id", "order") VALUES ($1, $2)');
  });
});

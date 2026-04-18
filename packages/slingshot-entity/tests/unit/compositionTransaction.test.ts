import { describe, expect, it } from 'bun:test';
import type { PostgresBundle, StoreInfra } from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, defineEntity, field, op } from '../../src/index';

const Parent = defineEntity('Parent', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
  },
});

const Child = defineEntity('Child', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    parentId: field.string(),
    label: field.string(),
  },
});

interface RowStore {
  [table: string]: Array<Record<string, unknown>>;
}

function cloneStore(store: RowStore): RowStore {
  return Object.fromEntries(
    Object.entries(store).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]),
  );
}

function createFakePostgresInfra(): {
  infra: StoreInfra;
  data: RowStore;
  poolQueries: string[];
  clientQueries: string[];
  released: { count: number };
} {
  const data: RowStore = {};
  const poolQueries: string[] = [];
  const clientQueries: string[] = [];
  const released = { count: 0 };

  let transactionData: RowStore | null = null;

  function currentStore(): RowStore {
    return transactionData ?? data;
  }

  async function handleQuery(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    if (sql === 'BEGIN') {
      transactionData = cloneStore(data);
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      const committed = transactionData ?? {};
      for (const key of Object.keys(data)) delete data[key];
      for (const [table, rows] of Object.entries(committed)) {
        data[table] = rows.map(row => ({ ...row }));
      }
      transactionData = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      transactionData = null;
      return { rows: [], rowCount: 0 };
    }

    const createTable = /^CREATE TABLE IF NOT EXISTS\s+([^\s(]+)\s*\(/i.exec(sql);
    if (createTable) {
      const table = createTable[1];
      currentStore()[table] ??= [];
      return { rows: [], rowCount: 0 };
    }

    if (/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    const insert = /^INSERT INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(sql);
    if (insert) {
      const table = insert[1];
      const columns = insert[2].split(',').map(part => part.trim());
      const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      const rows = (currentStore()[table] ??= []);
      const existingIndex = rows.findIndex(existing => existing['id'] === row['id']);
      if (existingIndex >= 0) {
        rows[existingIndex] = { ...rows[existingIndex], ...row };
      } else {
        rows.push(row);
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in fake Postgres adapter: ${sql}`);
  }

  const client = {
    async query(sql: string, params?: unknown[]) {
      clientQueries.push(sql);
      return handleQuery(sql, params);
    },
    release() {
      released.count++;
    },
  };

  const pool = {
    async connect() {
      return client;
    },
    async query(sql: string, params?: unknown[]) {
      poolQueries.push(sql);
      return handleQuery(sql, params);
    },
  };

  const infra: StoreInfra = {
    appName: 'test',
    getRedis() {
      throw new Error('Redis not configured');
    },
    getMongo() {
      throw new Error('Mongo not configured');
    },
    getSqliteDb() {
      throw new Error('SQLite not configured');
    },
    getPostgres() {
      return { pool, db: {} } as unknown as PostgresBundle;
    },
  };

  return { infra, data, poolQueries, clientQueries, released };
}

describe('createCompositeFactories — Postgres op.transaction', () => {
  it('commits cross-entity writes on a single Postgres client', async () => {
    const { infra, data, poolQueries, clientQueries, released } = createFakePostgresInfra();
    const factories = createCompositeFactories(
      {
        parents: { config: Parent },
        children: { config: Child },
      },
      {
        createBundle: op.transaction({
          steps: [
            { op: 'create', entity: 'parents', input: { name: 'param:name' } },
            {
              op: 'create',
              entity: 'children',
              input: { parentId: 'result:0.id', label: 'param:label' },
            },
          ],
        }),
      },
    );

    const composite = factories.postgres(infra) as {
      createBundle(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    };

    const results = await composite.createBundle({ name: 'Acme', label: 'HQ' });
    const parentId = results[0]?.id;
    const parentTable = `slingshot_${Parent._storageName}`;
    const childTable = `slingshot_${Child._storageName}`;

    expect(parentId).toBeDefined();
    expect(results[1]?.parentId).toBe(parentId);
    expect(data[parentTable]).toHaveLength(1);
    expect(data[childTable]).toHaveLength(1);
    expect(data[childTable]?.[0]?.parent_id).toBe(parentId);
    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('COMMIT');
    expect(poolQueries).toHaveLength(0);
    expect(released.count).toBe(1);
  });

  it('rolls back prior writes when a later transaction step fails', async () => {
    const { infra, data, clientQueries, released } = createFakePostgresInfra();
    const factories = createCompositeFactories(
      {
        parents: { config: Parent },
        children: { config: Child },
      },
      {
        createThenFail: op.transaction({
          steps: [
            { op: 'create', entity: 'parents', input: { name: 'param:name' } },
            { op: 'create', entity: 'missingEntity', input: { label: 'param:label' } },
          ],
        }),
      },
    );

    const composite = factories.postgres(infra) as {
      createThenFail(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    };

    await expect(composite.createThenFail({ name: 'Acme', label: 'HQ' })).rejects.toThrow(
      "Entity 'missingEntity' not found",
    );

    expect(data[`slingshot_${Parent._storageName}`] ?? []).toHaveLength(0);
    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('ROLLBACK');
    expect(released.count).toBe(1);
  });
});

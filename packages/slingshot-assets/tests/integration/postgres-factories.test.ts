import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { createAssetFactories } from '../../src/entities/factories';

type PgRow = Record<string, unknown>;
type PgQueryResult = { rows: PgRow[]; rowCount: number | null };

const ASSET_TABLE = 'slingshot_assets_assets';

class FakeAssetPostgresPool {
  readonly rows: PgRow[] = [];
  readonly queries: string[] = [];

  query(sql: string, params: unknown[] = []): Promise<PgQueryResult> {
    this.queries.push(sql);

    if (
      sql.startsWith('CREATE TABLE IF NOT EXISTS') ||
      sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
      sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS')
    ) {
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith(`INSERT INTO ${ASSET_TABLE} (`)) {
      const match = /^INSERT INTO [^(]+\(([^)]+)\) VALUES/.exec(sql);
      if (!match?.[1]) throw new Error(`Unable to parse insert columns: ${sql}`);
      const columns = match[1].split(',').map(column => column.trim());
      const row: PgRow = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i] ?? `col_${i}`] = params[i];
      }

      const existingIndex = this.rows.findIndex(entry => entry.id === row.id);
      if (existingIndex >= 0) {
        this.rows[existingIndex] = row;
      } else {
        this.rows.push(row);
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    if (sql === `SELECT * FROM ${ASSET_TABLE} WHERE id = $1 LIMIT 1`) {
      const id = String(params[0]);
      const row = this.rows.find(entry => String(entry.id) === id);
      return Promise.resolve({ rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 });
    }

    if (sql === `SELECT * FROM ${ASSET_TABLE} WHERE key = $1 LIMIT 1`) {
      const key = String(params[0]);
      const row = this.rows.find(entry => String(entry.key) === key);
      return Promise.resolve({ rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 });
    }

    if (sql === `SELECT 1 FROM ${ASSET_TABLE} WHERE key = $1 LIMIT 1`) {
      const key = String(params[0]);
      const row = this.rows.find(entry => String(entry.key) === key);
      return Promise.resolve({ rows: row ? [{ one: 1 }] : [], rowCount: row ? 1 : 0 });
    }

    if (sql === `SELECT * FROM ${ASSET_TABLE} WHERE owner_user_id = $1`) {
      const ownerUserId = String(params[0]);
      return Promise.resolve({
        rows: this.rows
          .filter(entry => String(entry.owner_user_id) === ownerUserId)
          .map(entry => ({ ...entry })),
        rowCount: null,
      });
    }

    if (sql === `DELETE FROM ${ASSET_TABLE} WHERE id = $1`) {
      const id = String(params[0]);
      const before = this.rows.length;
      const nextRows = this.rows.filter(entry => String(entry.id) !== id);
      this.rows.splice(0, this.rows.length, ...nextRows);
      return Promise.resolve({ rows: [], rowCount: before - nextRows.length });
    }

    if (sql === `DELETE FROM ${ASSET_TABLE}`) {
      const count = this.rows.length;
      this.rows.splice(0, this.rows.length);
      return Promise.resolve({ rows: [], rowCount: count });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

function createPostgresInfra(pool: FakeAssetPostgresPool): StoreInfra {
  const infra: StoreInfra = {
    appName: 'assets-test',
    getRedis() {
      throw new Error('Redis is not configured in this test');
    },
    getMongo() {
      throw new Error('Mongo is not configured in this test');
    },
    getSqliteDb() {
      throw new Error('SQLite is not configured in this test');
    },
    getPostgres() {
      return { pool: pool as unknown as Pool, db: {} };
    },
  };
  return infra;
}

describe('slingshot-assets postgres factories', () => {
  test('postgres factory enforces TTL on reads and custom lookup operations', async () => {
    const pool = new FakeAssetPostgresPool();
    const factories = createAssetFactories(60);
    const assets = factories.postgres(createPostgresInfra(pool));

    const fresh = await assets.create({
      id: 'asset-fresh',
      key: 'fresh-key',
      ownerUserId: 'user-1',
      originalName: 'fresh.txt',
      createdAt: new Date().toISOString(),
    });
    const expired = await assets.create({
      id: 'asset-expired',
      key: 'expired-key',
      ownerUserId: 'user-1',
      originalName: 'expired.txt',
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    const byOwner = await assets.listByOwner({ ownerUserId: 'user-1' });
    expect(byOwner.items.map(asset => asset.id)).toEqual([fresh.id]);
    expect(pool.rows.some(row => String(row.id) === expired.id)).toBe(false);

    expect((await assets.findByKey({ key: fresh.key }))?.id).toBe(fresh.id);
    expect(await assets.findByKey({ key: expired.key })).toBeNull();
    expect(await assets.existsByKey({ key: fresh.key })).toBe(true);
    expect(await assets.existsByKey({ key: expired.key })).toBe(false);
  });
});

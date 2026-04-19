import { describe, expect, test } from 'bun:test';
import { createPostgresInitializer } from '../../packages/slingshot-auth/src/lib/postgresInit';

describe('createPostgresInitializer', () => {
  test('wraps schema bootstrap in BEGIN / COMMIT and only runs once', async () => {
    const clientQueries: string[] = [];
    let releases = 0;
    let schemaCalls = 0;

    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            clientQueries.push(sql);
            return { rows: [], rowCount: 0 };
          },
          release() {
            releases++;
          },
        };
      },
    };

    const ensureTable = createPostgresInitializer(pool as never, async client => {
      schemaCalls++;
      await client.query('CREATE TABLE IF NOT EXISTS sample_table (id TEXT PRIMARY KEY)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_sample_table_id ON sample_table(id)');
    });

    await ensureTable();
    await ensureTable();

    expect(schemaCalls).toBe(1);
    expect(clientQueries).toEqual([
      'BEGIN',
      'CREATE TABLE IF NOT EXISTS sample_table (id TEXT PRIMARY KEY)',
      'CREATE INDEX IF NOT EXISTS idx_sample_table_id ON sample_table(id)',
      'COMMIT',
    ]);
    expect(releases).toBe(1);
  });

  test('rolls back failed bootstrap work and retries on the next call', async () => {
    const clientQueries: string[] = [];
    let releases = 0;
    let attempts = 0;

    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            clientQueries.push(sql);
            return { rows: [], rowCount: 0 };
          },
          release() {
            releases++;
          },
        };
      },
    };

    const ensureTable = createPostgresInitializer(pool as never, async client => {
      attempts++;
      await client.query('CREATE TABLE IF NOT EXISTS sample_table (id TEXT PRIMARY KEY)');
      if (attempts === 1) {
        throw new Error('bootstrap failed');
      }
      await client.query('CREATE INDEX IF NOT EXISTS idx_sample_table_id ON sample_table(id)');
    });

    await expect(ensureTable()).rejects.toThrow('bootstrap failed');
    expect(clientQueries).toEqual([
      'BEGIN',
      'CREATE TABLE IF NOT EXISTS sample_table (id TEXT PRIMARY KEY)',
      'ROLLBACK',
    ]);
    expect(releases).toBe(1);

    clientQueries.length = 0;
    await ensureTable();

    expect(attempts).toBe(2);
    expect(clientQueries).toEqual([
      'BEGIN',
      'CREATE TABLE IF NOT EXISTS sample_table (id TEXT PRIMARY KEY)',
      'CREATE INDEX IF NOT EXISTS idx_sample_table_id ON sample_table(id)',
      'COMMIT',
    ]);
    expect(releases).toBe(2);
  });
});

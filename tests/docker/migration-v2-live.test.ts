import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { defineEntity, field } from '../../packages/slingshot-entity/src';
import {
  diffEntityConfig,
  generateMigrationPostgres,
  generateMigrationSqlite,
} from '../../packages/slingshot-entity/src/migrations';

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

const V1 = defineEntity('RenameFixture', {
  fields: {
    id: field.string({ primary: true }),
    oldName: field.string(),
  },
});
const V2 = defineEntity('RenameFixture', {
  fields: {
    id: field.string({ primary: true }),
    newName: field.string({ renameFrom: 'oldName' }),
  },
});

describe('migration v2 explicit rename live fixtures', () => {
  const schema = `migration_v2_${randomUUID().replaceAll('-', '_')}`;
  const admin = new Pool({ connectionString: POSTGRES_URL });
  let postgres: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(POSTGRES_URL);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    postgres = new Pool({ connectionString: scoped.toString() });
  });

  afterAll(async () => {
    await postgres.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test('PostgreSQL rename retains existing data', async () => {
    await postgres.query(
      'CREATE TABLE "slingshot_rename_fixtures" ("id" TEXT PRIMARY KEY, "old_name" TEXT NOT NULL)',
    );
    await postgres.query(
      `INSERT INTO "slingshot_rename_fixtures" ("id", "old_name") VALUES ('one', 'retained')`,
    );
    await postgres.query(generateMigrationPostgres(diffEntityConfig(V1, V2)));
    const result = await postgres.query<{ new_name: string }>(
      'SELECT "new_name" FROM "slingshot_rename_fixtures" WHERE "id" = $1',
      ['one'],
    );
    expect(result.rows[0]?.new_name).toBe('retained');
  });

  test('SQLite rename retains existing data', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE "rename_fixtures" ("id" TEXT PRIMARY KEY, "old_name" TEXT NOT NULL)');
      db.exec(`INSERT INTO "rename_fixtures" ("id", "old_name") VALUES ('one', 'retained')`);
      db.exec(generateMigrationSqlite(diffEntityConfig(V1, V2)));
      expect(
        db.query('SELECT "new_name" FROM "rename_fixtures" WHERE "id" = ?').get('one'),
      ).toEqual({ new_name: 'retained' });
    } finally {
      db.close();
    }
  });
});

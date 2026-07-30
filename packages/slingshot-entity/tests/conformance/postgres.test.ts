import { describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  ENTITY_BACKEND_CAPABILITIES,
  defineEntity,
  field,
  index,
} from '@lastshotlabs/slingshot-core';
import { createPostgresEntityAdapter } from '../../src/configDriven/postgresAdapter';
import {
  ENTITY_CONFORMANCE_CATALOG,
  ENTITY_CONFORMANCE_DEFINITIONS,
  createPostgresEntityConformanceDriver,
  runEntityConformance,
} from '../../src/testing';

const TEST_POSTGRES_URL = process.env['TEST_POSTGRES_URL'];

function assertPassed(results: Awaited<ReturnType<typeof runEntityConformance>>): void {
  const failures = results.filter(result => result.status === 'failed');
  expect(failures).toEqual([]);
}

describe.skipIf(!TEST_POSTGRES_URL)('entity conformance — live PostgreSQL', () => {
  test('passes every claimed case and covers every supported capability', async () => {
    const driver = createPostgresEntityConformanceDriver(TEST_POSTGRES_URL);
    const results = await runEntityConformance(driver);
    assertPassed(results);

    expect(results.map(result => result.caseId)).toEqual(
      ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id),
    );
    expect(
      results.find(result => result.caseId === 'composition.transaction-rollback')?.status,
    ).toBe('passed');
    expect(
      results.find(result => result.caseId === 'regression.guard-changing-update')?.status,
    ).toBe('passed');

    for (const capability of ENTITY_BACKEND_CAPABILITIES) {
      if (driver.profile.capabilities[capability].status === 'supported') {
        expect(
          results.some(
            result =>
              result.status === 'passed' && result.requiredCapabilities.includes(capability),
          ),
        ).toBe(true);
      }
    }
  });

  test('destroy is idempotent and schema-scoped', async () => {
    const harness = await createPostgresEntityConformanceDriver(TEST_POSTGRES_URL).createHarness(
      ENTITY_CONFORMANCE_DEFINITIONS,
    );
    await harness.destroy();
    await harness.destroy();
  });

  test('tenant composite uniqueness treats null tenant IDs as equal', async () => {
    const table = `slingshot_null_tenant_unique_${process.pid}`;
    const Entity = defineEntity('NullTenantUnique', {
      storage: { postgres: { tableName: table } },
      fields: {
        id: field.string({ primary: true }),
        tenantId: field.string({ optional: true }),
        slug: field.string(),
      },
      indexes: [index(['slug', 'tenantId'], { unique: true })],
    });
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });

    try {
      const adapter = createPostgresEntityAdapter(pool, Entity);
      await adapter.create({ id: 'first', slug: 'same-slug' });
      await expect(adapter.create({ id: 'second', slug: 'same-slug' })).rejects.toMatchObject({
        status: 409,
        code: 'UNIQUE_VIOLATION',
      });

      const result = await pool.query<{ indnullsnotdistinct: boolean }>(
        `SELECT i.indnullsnotdistinct
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1`,
        [`idx_${table}_slug_tenant_id`],
      );
      expect(result.rows).toEqual([{ indnullsnotdistinct: true }]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}"`);
      await pool.end();
    }
  });
});

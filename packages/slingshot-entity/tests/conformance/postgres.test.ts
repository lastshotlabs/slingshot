import { describe, expect, test } from 'bun:test';
import { ENTITY_BACKEND_CAPABILITIES } from '@lastshotlabs/slingshot-core';
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
});

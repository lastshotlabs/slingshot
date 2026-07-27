import { describe, expect, test } from 'bun:test';
import {
  ENTITY_BACKEND_CAPABILITIES,
  type StoreInfra,
  createUnsupportedTransactionManager,
} from '@lastshotlabs/slingshot-core';
import { createCompositeFactories } from '../../src/configDriven';
import {
  ENTITY_CONFORMANCE_CATALOG,
  ENTITY_CONFORMANCE_DEFINITIONS,
  createMongoEntityConformanceDriver,
  runEntityConformance,
} from '../../src/testing';
import { CONFORMANCE_COMPOSITE_OPERATIONS } from '../../src/testing/fixtures';

const TEST_MONGO_URL = process.env['TEST_MONGO_URL'];

function assertPassed(results: Awaited<ReturnType<typeof runEntityConformance>>): void {
  expect(results.filter(result => result.status === 'failed')).toEqual([]);
}

describe.skipIf(!TEST_MONGO_URL)('entity conformance — live MongoDB', () => {
  test('passes every claimed case and covers every supported capability', async () => {
    const driver = createMongoEntityConformanceDriver(TEST_MONGO_URL);
    const results = await runEntityConformance(driver);
    assertPassed(results);

    expect(results.map(result => result.caseId)).toEqual(
      ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id),
    );
    expect(
      results.find(result => result.caseId === 'crud.primary-duplicate-conflict')?.status,
    ).toBe('passed');
    expect(
      results.find(result => result.caseId === 'regression.guard-changing-update')?.status,
    ).toBe('passed');
    expect(
      results.find(result => result.caseId === 'composition.transaction-rollback')?.status,
    ).toBe('skipped');

    for (const capability of ENTITY_BACKEND_CAPABILITIES) {
      const hasSelectableCase = ENTITY_CONFORMANCE_CATALOG.some(
        testCase =>
          testCase.requires.includes(capability) &&
          testCase.requires.every(
            requirement => driver.profile.capabilities[requirement].status === 'supported',
          ),
      );
      if (driver.profile.capabilities[capability].status === 'supported' && hasSelectableCase) {
        expect(
          results.some(
            result =>
              result.status === 'passed' && result.requiredCapabilities.includes(capability),
          ),
        ).toBe(true);
      }
    }
  });

  test('rejects transaction configuration during bootstrap', () => {
    const entries = Object.fromEntries(
      ENTITY_CONFORMANCE_DEFINITIONS.map(definition => [
        definition.key,
        { config: definition.config },
      ]),
    );
    const unavailable = (): never => {
      throw new Error('Infrastructure must not be accessed');
    };
    const infra: StoreInfra = {
      appName: 'entity-conformance',
      getTransactions: () => createUnsupportedTransactionManager(),
      getRedis: unavailable,
      getMongo: unavailable,
      getSqliteDb: unavailable,
      getPostgres: unavailable,
    };

    expect(() =>
      createCompositeFactories(entries, {
        rollbackPair: CONFORMANCE_COMPOSITE_OPERATIONS.rollbackPair,
      }).mongo(infra),
    ).toThrow(/transaction\.rollback/);
  });

  test('destroy is idempotent and database-scoped', async () => {
    const harness = await createMongoEntityConformanceDriver(TEST_MONGO_URL).createHarness(
      ENTITY_CONFORMANCE_DEFINITIONS,
    );
    await harness.destroy();
    await harness.destroy();
  });
});

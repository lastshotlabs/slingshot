import { describe, expect, test } from 'bun:test';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { ENTITY_BACKEND_CAPABILITIES, ENTITY_OPERATION_KINDS } from '@lastshotlabs/slingshot-core';
import { createCompositeFactories } from '../../src/configDriven/composition';
import {
  ENTITY_CONFORMANCE_CATALOG,
  createMemoryEntityConformanceDriver,
  runEntityConformance,
} from '../../src/testing';
import {
  CONFORMANCE_COMPOSITE_OPERATIONS,
  ENTITY_CONFORMANCE_DEFINITIONS,
} from '../../src/testing/fixtures';

function assertPassed(results: Awaited<ReturnType<typeof runEntityConformance>>): void {
  const failures = results.filter(result => result.status === 'failed');
  expect(failures).toEqual([]);
}

const raceCases = ENTITY_CONFORMANCE_CATALOG.filter(testCase => testCase.id.startsWith('race.'));

describe('entity conformance — memory', () => {
  test('runs the complete catalog and repeats every race in three isolated harnesses', async () => {
    const driver = createMemoryEntityConformanceDriver();
    const first = await runEntityConformance(driver);
    assertPassed(first);

    for (let run = 1; run < 3; run++) {
      assertPassed(await runEntityConformance(driver, raceCases));
    }

    expect(first.map(result => result.caseId)).toEqual(
      ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id),
    );
    expect(
      first
        .filter(result => result.status === 'skipped')
        .every(result =>
          result.requiredCapabilities.some(
            capability => driver.profile.capabilities[capability].status === 'unsupported',
          ),
        ),
    ).toBe(true);
  });

  test('rejects transaction configuration during bootstrap before child construction', () => {
    const entries = Object.fromEntries(
      ENTITY_CONFORMANCE_DEFINITIONS.map(definition => [
        definition.key,
        {
          config: definition.config,
          ...(definition.operations ? { operations: { ...definition.operations } } : {}),
        },
      ]),
    );
    let infraAccesses = 0;
    const unavailable = (): never => {
      infraAccesses++;
      throw new Error('Infrastructure must not be accessed');
    };
    const infra: StoreInfra = {
      appName: 'entity-conformance',
      getRedis: unavailable,
      getMongo: unavailable,
      getSqliteDb: unavailable,
      getPostgres: unavailable,
    };

    expect(() =>
      createCompositeFactories(entries, {
        rollbackPair: CONFORMANCE_COMPOSITE_OPERATIONS.rollbackPair,
      }).memory(infra),
    ).toThrow(/transaction\.rollback/);
    expect(infraAccesses).toBe(0);
  });

  test('catalog metadata covers every operation kind and backend capability', () => {
    const requirements = new Set(ENTITY_CONFORMANCE_CATALOG.flatMap(testCase => testCase.requires));
    for (const capability of ENTITY_BACKEND_CAPABILITIES) {
      expect(requirements.has(capability)).toBe(true);
    }
    for (const kind of ENTITY_OPERATION_KINDS) {
      expect(requirements.has(`operation.${kind}`)).toBe(true);
    }
    expect(Object.isFrozen(ENTITY_CONFORMANCE_CATALOG)).toBe(true);
    expect(ENTITY_CONFORMANCE_CATALOG.every(testCase => Object.isFrozen(testCase))).toBe(true);
  });
});

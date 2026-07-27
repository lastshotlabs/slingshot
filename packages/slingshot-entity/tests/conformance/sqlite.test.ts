import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import {
  ENTITY_CONFORMANCE_CATALOG,
  ENTITY_CONFORMANCE_DEFINITIONS,
  createSqliteEntityConformanceDriver,
  runEntityConformance,
} from '../../src/testing';

function assertPassed(results: Awaited<ReturnType<typeof runEntityConformance>>): void {
  const failures = results.filter(result => result.status === 'failed');
  expect(failures).toEqual([]);
}

const raceCases = ENTITY_CONFORMANCE_CATALOG.filter(testCase => testCase.id.startsWith('race.'));

describe('entity conformance — SQLite', () => {
  test('runs the identical catalog, proves rollback, and repeats races in isolated files', async () => {
    const driver = createSqliteEntityConformanceDriver();
    const first = await runEntityConformance(driver);
    assertPassed(first);

    for (let run = 1; run < 3; run++) {
      assertPassed(await runEntityConformance(driver, raceCases));
    }

    expect(first.map(result => result.caseId)).toEqual(
      ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id),
    );
    expect(first.find(result => result.caseId === 'composition.transaction-rollback')?.status).toBe(
      'passed',
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

  test('destroy is idempotent', async () => {
    const harness = await createSqliteEntityConformanceDriver().createHarness(
      ENTITY_CONFORMANCE_DEFINITIONS,
    );
    await harness.destroy();
    await harness.destroy();
  });

  test('shared catalog contains no backend branch or test skip primitive', async () => {
    const source = await readFile(new URL('../../src/testing/catalog.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(
      /driver\.name|store\s*===|\.skip\(|\.todo\(|describe\.skip|test\.skip/,
    );
  });
});

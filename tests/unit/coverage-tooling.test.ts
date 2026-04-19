import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

describe('coverage tooling', () => {
  let tempDir = '';
  const originalSuiteFilter = Bun.env.SLINGSHOT_SUITE_FILTER;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slingshot-coverage-tooling-'));
    delete Bun.env.SLINGSHOT_SUITE_FILTER;
  });

  afterEach(async () => {
    mock.restore();
    Bun.env.SLINGSHOT_SUITE_FILTER = originalSuiteFilter;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = '';
    }
  });

  test('discovers root and package coverage suites and respects suite filters', async () => {
    const unfiltered = await import(`../../scripts/workspace-test-suites.ts?all=${Date.now()}`);
    expect(
      unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'root'),
    ).toBe(true);
    expect(
      unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'runtime-bun'),
    ).toBe(true);
    expect(
      unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'slingshot-auth'),
    ).toBe(true);

    Bun.env.SLINGSHOT_SUITE_FILTER = 'root,runtime-bun';
    const filtered = await import(`../../scripts/workspace-test-suites.ts?filtered=${Date.now()}`);
    expect(filtered.coverageSuites.map((suite: { name: string }) => suite.name)).toEqual([
      'root',
      'runtime-bun',
    ]);
    expect(filtered.packageTestSuites.map((suite: { name: string }) => suite.name)).toEqual([
      'runtime-bun',
    ]);
  });

  test('parses and filters LCOV artifacts to suite-owned files', async () => {
    const artifactPath = join(tempDir, 'lcov.info');
    await writeFile(
      artifactPath,
      [
        'TN:',
        'SF:scripts/workspace-test-suites.ts',
        'FNF:1',
        'FNH:1',
        'LF:4',
        'LH:4',
        'end_of_record',
        'TN:',
        'SF:src/index.ts',
        'FNF:1',
        'FNH:0',
        'LF:10',
        'LH:0',
        'end_of_record',
        '',
      ].join('\n'),
      'utf8',
    );

    const { filterLcovToOwnedFiles, parseLcov } = await import(
      `../../scripts/coverage-lcov.ts?lcov=${Date.now()}`
    );

    await filterLcovToOwnedFiles(artifactPath, {
      name: 'tooling',
      testsPath: 'tests',
      coverageDir: tempDir,
      command: [],
      ownedGlobs: ['scripts/workspace-test-suites.ts'],
      ignoredGlobs: [],
    });

    const filtered = await readFile(artifactPath, 'utf8');
    expect(filtered).toContain('SF:scripts/workspace-test-suites.ts');
    expect(filtered).not.toContain('SF:src/index.ts');

    const report = parseLcov(artifactPath);
    expect(report.files.get('scripts/workspace-test-suites.ts')).toEqual({
      linesFound: 4,
      linesHit: 4,
      functionsFound: 1,
      functionsHit: 1,
      branchesFound: 0,
      branchesHit: 0,
    });
  });

  test('detects files that do and do not need runtime coverage', async () => {
    const { fileNeedsRuntimeCoverage } = await import(
      `../../scripts/coverage-lcov.ts?runtime=${Date.now()}`
    );

    expect(fileNeedsRuntimeCoverage('src/lib/appConfig.ts')).toBe(true);
    expect(fileNeedsRuntimeCoverage('src/config/types/db.ts')).toBe(false);
  });

  test('partitions root tests so module-mocking files run isolated', async () => {
    const { collectRootTestFiles, fileRequiresIsolatedProcess, partitionRootTestFiles } =
      await import(`../../scripts/root-test-files.ts?root=${Date.now()}`);

    const files = await collectRootTestFiles();
    const { bulk, isolated } = partitionRootTestFiles(files);
    const normalizedBulk = bulk.map((file: string) => file.replace(/\\/g, '/'));
    const normalizedIsolated = isolated.map((file: string) => file.replace(/\\/g, '/'));

    expect(fileRequiresIsolatedProcess('tests/unit/manifestBuiltinConfig.test.ts')).toBe(true);
    expect(fileRequiresIsolatedProcess('tests/unit/webhookAuth.test.ts')).toBe(false);
    expect(normalizedIsolated).toContain('tests/unit/manifestBuiltinConfig.test.ts');
    expect(normalizedIsolated).toContain('tests/unit/wsDispatch.test.ts');
    expect(normalizedBulk).toContain('tests/unit/webhookAuth.test.ts');
  });
});

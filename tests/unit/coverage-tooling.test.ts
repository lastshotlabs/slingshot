import { mkdirSync, writeFileSync } from 'node:fs';
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
    expect(unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'root')).toBe(
      true,
    );
    expect(
      unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'runtime-bun'),
    ).toBe(true);
    expect(
      unfiltered.coverageSuites.some((suite: { name: string }) => suite.name === 'slingshot-auth'),
    ).toBe(true);
    expect(
      unfiltered.coverageSuites.some(
        (suite: { name: string }) => suite.name === 'slingshot-bullmq',
      ),
    ).toBe(true);

    Bun.env.SLINGSHOT_SUITE_FILTER = 'root,runtime-bun,slingshot-bullmq';
    const filtered = await import(`../../scripts/workspace-test-suites.ts?filtered=${Date.now()}`);
    expect(filtered.coverageSuites.map((suite: { name: string }) => suite.name)).toEqual([
      'root',
      'runtime-bun',
      'slingshot-bullmq',
    ]);
    expect(filtered.packageTestSuites.map((suite: { name: string }) => suite.name)).toEqual([
      'runtime-bun',
      'slingshot-bullmq',
    ]);
  });

  test('parses, merges, and filters LCOV artifacts to suite-owned files', async () => {
    const artifactPath = join(tempDir, 'lcov.info');
    await writeFile(
      artifactPath,
      [
        'TN:',
        'SF:scripts/workspace-test-suites.ts',
        'FN:1,mergeCoverage',
        'FNDA:0,mergeCoverage',
        'DA:1,1',
        'DA:2,0',
        'LF:2',
        'LH:1',
        'end_of_record',
        'TN:',
        'SF:scripts/workspace-test-suites.ts',
        'FN:1,mergeCoverage',
        'FNDA:1,mergeCoverage',
        'DA:2,1',
        'BRDA:2,0,0,0',
        'BRDA:2,0,1,1',
        'BRF:2',
        'BRH:1',
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

    const { filterLcovContentToOwnedFiles, filterLcovToOwnedFiles, parseLcov } = await import(
      `../../scripts/coverage-lcov.ts?lcov=${Date.now()}`
    );

    const mergedContent = await readFile(artifactPath, 'utf8');
    const filteredContent = await filterLcovContentToOwnedFiles(mergedContent, {
      name: 'tooling',
      testsPath: 'tests',
      coverageDir: tempDir,
      command: [],
      ownedGlobs: ['scripts/workspace-test-suites.ts'],
      ignoredGlobs: [],
    });

    expect(filteredContent).toContain('SF:scripts/workspace-test-suites.ts');
    expect(filteredContent).not.toContain('SF:src/index.ts');

    await filterLcovToOwnedFiles(artifactPath, {
      name: 'tooling',
      testsPath: 'tests',
      coverageDir: tempDir,
      command: [],
      ownedGlobs: ['scripts/workspace-test-suites.ts'],
      ignoredGlobs: [],
    });

    const filtered = await readFile(artifactPath, 'utf8');
    expect(filtered).toBe(filteredContent);

    const report = parseLcov(artifactPath);
    expect(report.files.get('scripts/workspace-test-suites.ts')).toEqual({
      linesFound: 2,
      linesHit: 2,
      functionsFound: 1,
      functionsHit: 1,
      branchesFound: 2,
      branchesHit: 1,
    });
  });

  test('merges multiple LCOV artifacts into a single output', async () => {
    const firstPath = join(tempDir, 'first.info');
    const secondPath = join(tempDir, 'second.info');
    const mergedPath = join(tempDir, 'merged.info');

    await writeFile(firstPath, 'SF:src/a.ts\nLF:1\nLH:1\nend_of_record\n', 'utf8');
    await writeFile(secondPath, 'SF:src/b.ts\nLF:1\nLH:0\nend_of_record\n', 'utf8');

    const { mergeLcovArtifacts } = await import(
      `../../scripts/coverage-lcov.ts?merge=${Date.now()}`
    );

    mergeLcovArtifacts([firstPath, secondPath], mergedPath);

    const merged = await readFile(mergedPath, 'utf8');
    expect(merged).toContain('SF:src/a.ts');
    expect(merged).toContain('SF:src/b.ts');
  });

  test('derives per-suite artifacts from merged repo coverage so cross-suite hits still count', async () => {
    const { filterLcovContentToOwnedFiles, parseLcov } = await import(
      `../../scripts/coverage-lcov.ts?cross-suite=${Date.now()}`
    );

    const mergedContent = [
      'TN:',
      'SF:packages/slingshot-core/src/entityPolicy.ts',
      'FN:1,getOrCreateEntityPolicyRegistry',
      'FNDA:1,getOrCreateEntityPolicyRegistry',
      'DA:1,1',
      'DA:2,1',
      'LF:2',
      'LH:2',
      'end_of_record',
      'TN:',
      'SF:packages/slingshot-entity/src/index.ts',
      'FN:1,createEntityPlugin',
      'FNDA:1,createEntityPlugin',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      '',
    ].join('\n');

    const coreArtifact = await filterLcovContentToOwnedFiles(mergedContent, {
      name: 'slingshot-core',
      testsPath: 'packages/slingshot-core/tests',
      coverageDir: tempDir,
      command: [],
      ownedGlobs: ['packages/slingshot-core/src/entityPolicy.ts'],
      ignoredGlobs: [],
    });

    expect(coreArtifact).toContain('SF:packages/slingshot-core/src/entityPolicy.ts');
    expect(coreArtifact).not.toContain('SF:packages/slingshot-entity/src/index.ts');

    const coreArtifactPath = join(tempDir, 'core.info');
    await writeFile(coreArtifactPath, coreArtifact, 'utf8');

    const report = parseLcov(coreArtifactPath);
    expect(report.files.get('packages/slingshot-core/src/entityPolicy.ts')).toEqual({
      linesFound: 2,
      linesHit: 2,
      functionsFound: 1,
      functionsHit: 1,
      branchesFound: 0,
      branchesHit: 0,
    });
  });

  test('normalizes Bun LCOV source paths before matching owned files', async () => {
    const { filterLcovContentToOwnedFiles, parseLcov } = await import(
      `../../scripts/coverage-lcov.ts?normalize=${Date.now()}`
    );
    const absoluteWorkspaceSuitePath = join(process.cwd(), 'scripts/workspace-test-suites.ts');

    const mergedContent = [
      'TN:',
      'SF:../../scripts/workspace-test-suites.ts',
      'FN:1,coverageSuites',
      'FNDA:1,coverageSuites',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      'TN:',
      `SF:${absoluteWorkspaceSuitePath}`,
      'FN:2,packageTestSuites',
      'FNDA:1,packageTestSuites',
      'DA:2,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      'TN:',
      'SF:../packages/slingshot-core/src/entityPolicy.ts',
      'FN:1,getOrCreateEntityPolicyRegistry',
      'FNDA:1,getOrCreateEntityPolicyRegistry',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      'TN:',
      'SF:../outside-project/src/index.ts',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      '',
    ].join('\n');

    const filteredContent = await filterLcovContentToOwnedFiles(mergedContent, {
      name: 'normalizer',
      testsPath: 'tests',
      coverageDir: tempDir,
      command: [],
      ownedGlobs: [
        'scripts/workspace-test-suites.ts',
        'packages/slingshot-core/src/entityPolicy.ts',
      ],
      ignoredGlobs: [],
    });

    expect(filteredContent).toContain('SF:../../scripts/workspace-test-suites.ts');
    expect(filteredContent).toContain(`SF:${absoluteWorkspaceSuitePath}`);
    expect(filteredContent).toContain('SF:../packages/slingshot-core/src/entityPolicy.ts');
    expect(filteredContent).not.toContain('outside-project');

    const artifactPath = join(tempDir, 'normalized.info');
    await writeFile(artifactPath, filteredContent, 'utf8');

    const report = parseLcov(artifactPath);
    expect(report.files.get('scripts/workspace-test-suites.ts')).toEqual({
      linesFound: 2,
      linesHit: 2,
      functionsFound: 2,
      functionsHit: 2,
      branchesFound: 0,
      branchesHit: 0,
    });
    expect(report.files.get('packages/slingshot-core/src/entityPolicy.ts')).toEqual({
      linesFound: 1,
      linesHit: 1,
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
    expect(fileNeedsRuntimeCoverage('packages/slingshot-bullmq/src/index.ts')).toBe(false);
    expect(fileNeedsRuntimeCoverage('packages/slingshot-interactions/src/config/types.ts')).toBe(
      false,
    );
  });

  test('partitions root tests so module-mocking files run isolated', async () => {
    const {
      collectRootCoverageTestFiles,
      collectRootTestFiles,
      fileRequiresIsolatedProcess,
      partitionRootTestFiles,
    } = await import(`../../scripts/root-test-files.ts?root=${Date.now()}`);

    const files = await collectRootTestFiles();
    const coverageFiles = await collectRootCoverageTestFiles();
    const { bulk, isolated } = partitionRootTestFiles(files);
    const normalizedBulk = bulk.map((file: string) => file.replace(/\\/g, '/'));
    const normalizedCoverage = coverageFiles.map((file: string) => file.replace(/\\/g, '/'));
    const normalizedIsolated = isolated.map((file: string) => file.replace(/\\/g, '/'));

    expect(fileRequiresIsolatedProcess('tests/unit/manifestBuiltinConfig.test.ts')).toBe(true);
    expect(fileRequiresIsolatedProcess('tests/unit/auditLogProviders.test.ts')).toBe(true);
    expect(fileRequiresIsolatedProcess('tests/unit/webhookAuth.test.ts')).toBe(false);
    expect(normalizedCoverage).toContain('tests/isolated/queue.test.ts');
    expect(normalizedCoverage).toContain('tests/isolated/zodToMongoose.test.ts');
    expect(normalizedIsolated).toContain('tests/unit/auditLogProviders.test.ts');
    expect(normalizedIsolated).toContain('tests/unit/manifestBuiltinConfig.test.ts');
    expect(normalizedBulk).toContain('tests/unit/webhookAuth.test.ts');
    expect(normalizedBulk).toContain('tests/unit/wsDispatch.test.ts');
  });

  test('test runners ignore stdin so accidental CLI prompts cannot block automation', async () => {
    const spawnCalls: Array<{
      cmd: string[];
      opts: Record<string, unknown>;
    }> = [];
    const spawnFn = ((cmd: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, opts });
      const coverageDirFlagIndex = cmd.indexOf('--coverage-dir');
      if (coverageDirFlagIndex >= 0) {
        const coverageDir = cmd[coverageDirFlagIndex + 1];
        if (coverageDir) {
          mkdirSync(coverageDir, { recursive: true });
          writeFileSync(
            join(coverageDir, 'lcov.info'),
            'SF:scripts/run-coverage-files.ts\nLF:1\nLH:1\nend_of_record\n',
            'utf8',
          );
        }
      }
      return { exited: Promise.resolve(0) };
    }) as typeof Bun.spawn;

    const { runFiles } = await import(`../../scripts/run-root-tests.ts?stdin-root=${Date.now()}`);
    const { runSuite: runPackageSuite } = await import(
      `../../scripts/run-package-tests.ts?stdin-package=${Date.now()}`
    );
    const { runCoverageFiles } = await import(
      `../../scripts/run-coverage-files.ts?stdin-coverage-files=${Date.now()}`
    );
    const { runSuite: runCoverageSuite } = await import(
      `../../scripts/run-coverage.ts?stdin-coverage=${Date.now()}`
    );
    const { runStep } = await import(
      `../../scripts/run-docker-tests.ts?stdin-docker=${Date.now()}`
    );

    await runFiles('bulk 1', ['tests/unit/webhookAuth.test.ts'], spawnFn);
    await runPackageSuite(
      'slingshot-auth',
      ['bun', 'test', 'packages/slingshot-auth/tests'],
      spawnFn,
    );
    await runCoverageFiles(
      ['--coverage-dir', join(tempDir, 'coverage'), 'tests/unit/webhookAuth.test.ts'],
      spawnFn,
    );
    await runCoverageSuite('root', ['scripts/run-root-coverage.ts'], spawnFn);
    await runStep('root docker tests', ['bun', 'test', 'tests/docker/'], spawnFn, {
      TEST_POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5433/slingshot_test',
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5433/slingshot_test',
    });

    expect(spawnCalls.length).toBe(5);
    for (const [index, call] of spawnCalls.entries()) {
      expect(call.opts.stdin).toBe('ignore');
      expect(call.opts.stdout).toBe(index === 3 ? 'pipe' : 'inherit');
      expect(call.opts.stderr).toBe(index === 3 ? 'pipe' : 'inherit');
    }
  });
});

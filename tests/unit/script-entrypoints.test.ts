import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type SpawnCalls = Array<{ cmd: string[]; env?: Record<string, string | undefined> }>;

function createSpawnStub(
  handler?: (cmd: string[]) => void,
  calls: SpawnCalls = [],
): typeof Bun.spawn {
  return ((cmd: string[], options?: { env?: Record<string, string | undefined> }) => {
    calls.push({ cmd, env: options?.env });
    handler?.(cmd);
    return { exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
}

describe('script entrypoints', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'slingshot-script-tests-'));
  });

  afterEach(() => {
    mock.restore();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('ensures the pagefind junction exists when Bun hoists it', async () => {
    const { ensurePagefindLink, getPagefindPaths } = await import(
      `../../scripts/ensure-pagefind-link.ts?link=${Date.now()}`
    );

    const repoRoot = join(tempDir, 'repo');
    const paths = getPagefindPaths(repoRoot);
    mkdirSync(paths.bunHoistedTarget, { recursive: true });

    const logs: string[] = [];
    ensurePagefindLink(paths, {
      log: message => logs.push(message),
      warn: message => logs.push(message),
    });

    expect(existsSync(paths.expectedLink)).toBe(true);
    expect(logs.join('\n')).toContain('Linked');

    ensurePagefindLink(paths, {
      log: message => logs.push(message),
      warn: message => logs.push(message),
    });
    expect(existsSync(paths.expectedLink)).toBe(true);
  });

  test('audits example registry coverage and smoke checks with injected dependencies', async () => {
    const examplesRoot = join(tempDir, 'examples');
    const docsRoot = join(tempDir, 'docs');
    mkdirSync(join(examplesRoot, 'alpha'), { recursive: true });
    mkdirSync(join(examplesRoot, 'beta'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, 'alpha.md'), '# alpha\n', 'utf8');
    writeFileSync(join(tempDir, 'manifest.json'), '{"name":"demo"}\n', 'utf8');

    const coverageModule = await import(
      `../../scripts/examples-coverage.ts?coverage=${Date.now()}`
    );
    const smokeModule = await import(`../../scripts/examples-smoke.ts?smoke=${Date.now()}`);

    const registry = [
      {
        name: 'alpha',
        directory: 'examples/alpha',
        docsPath: 'docs/alpha.md',
        checks: [
          { kind: 'code-app', name: 'alpha', entrypoint: 'examples/alpha/index.ts' },
          {
            kind: 'module-exports',
            name: 'alpha-exports',
            entrypoint: 'examples/alpha/module.ts',
            exports: ['buildAppConfig'],
            requiredPlugins: ['auth'],
          },
          {
            kind: 'manifest',
            name: 'alpha-manifest',
            manifestPath: 'manifest.json',
            handlerModule: 'examples/alpha/handlers.ts',
            handlerExports: ['handle'],
          },
        ],
      },
    ];

    const audit = coverageModule.auditExamplesCoverage(registry as never, tempDir, examplesRoot);
    expect(audit.missingFromRegistry).toEqual(['examples/beta']);
    expect(audit.missingDocs).toEqual([]);

    const writes: string[] = [];
    const destroyed: string[] = [];
    await smokeModule.runExamplesSmoke(registry as never, { error() {}, log: message => writes.push(message) }, {
      root: tempDir,
      stdout: { write: message => writes.push(String(message)) },
      importModuleFn: async (entrypoint: string) => {
        if (entrypoint.endsWith('index.ts')) {
          return {
            buildAppConfig: () => ({ plugins: [{ name: 'auth' }] }),
          };
        }
        if (entrypoint.endsWith('module.ts')) {
          return {
            buildAppConfig: () => ({ plugins: [{ name: 'auth' }] }),
          };
        }
        return { handle() {} };
      },
      createAppFn: async () =>
        ({
          app: {},
          ctx: {
            destroy: async () => {
              destroyed.push('destroyed');
            },
          },
        }) as never,
      validateAppManifestFn: () => ({ success: true, errors: [] }) as never,
    });

    expect(writes.join('\n')).toContain('examples:smoke alpha:code-app');
    expect(writes.filter(line => line === 'ok')).toHaveLength(3);
    expect(destroyed).toEqual(['destroyed']);
  });

  test('runs coverage/test helper scripts and filters merged LCOV output', async () => {
    const runCoverageFilesModule = await import(
      `../../scripts/run-coverage-files.ts?files=${Date.now()}`
    );
    const runRootTestsModule = await import(`../../scripts/run-root-tests.ts?root=${Date.now()}`);
    const runRootCoverageModule = await import(
      `../../scripts/run-root-coverage.ts?rootcov=${Date.now()}`
    );
    const runPackageTestsModule = await import(
      `../../scripts/run-package-tests.ts?packages=${Date.now()}`
    );
    const runCoverageModule = await import(`../../scripts/run-coverage.ts?all=${Date.now()}`);

    const coverageDir = join(tempDir, 'coverage-files');
    const coverageCalls: SpawnCalls = [];
    const coverageSpawn = createSpawnStub(cmd => {
      const runDir = cmd[cmd.indexOf('--coverage-dir') + 1];
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'lcov.info'),
        `SF:scripts/ensure-pagefind-link.ts\nLF:1\nLH:1\nend_of_record\n`,
        'utf8',
      );
    }, coverageCalls);

    expect(runCoverageFilesModule.parseArgs(['--coverage-dir', coverageDir, '--label', 'demo', 'a.test.ts']).label).toBe(
      'demo',
    );
    expect(
      await runCoverageFilesModule.runCoverageFiles(
        ['--coverage-dir', coverageDir, '--label', 'demo', 'tests/unit/webhookAuth.test.ts'],
        coverageSpawn,
      ),
    ).toBe(0);
    expect(readFileSync(join(coverageDir, 'lcov.info'), 'utf8')).toContain(
      'SF:scripts/ensure-pagefind-link.ts',
    );
    expect(coverageCalls).toHaveLength(1);

    const rootCalls: SpawnCalls = [];
    expect(
      await runRootTestsModule.runRootTests(
        ['tests/unit/webhookAuth.test.ts', 'tests/unit/auditLogProviders.test.ts'],
        createSpawnStub(undefined, rootCalls),
      ),
    ).toBe(0);
    expect(rootCalls).toHaveLength(2);
    expect(rootCalls[0].cmd).toContain('tests/unit/webhookAuth.test.ts');
    expect(rootCalls[1].cmd).toContain('tests/unit/auditLogProviders.test.ts');

    const rootCoverageCalls: SpawnCalls = [];
    expect(
      await runRootCoverageModule.runRootCoverage(
        ['tests/unit/webhookAuth.test.ts', 'tests/unit/auditLogProviders.test.ts'],
        createSpawnStub(cmd => {
          const runDir = cmd[cmd.indexOf('--coverage-dir') + 1];
          mkdirSync(runDir, { recursive: true });
          writeFileSync(
            join(runDir, 'lcov.info'),
            `SF:scripts/run-root-coverage.ts\nLF:1\nLH:1\nend_of_record\n`,
            'utf8',
          );
        }, rootCoverageCalls),
      ),
    ).toBe(0);
    expect(rootCoverageCalls).toHaveLength(2);
    expect(readFileSync(join('coverage', 'root', 'lcov.info'), 'utf8')).toContain(
      'SF:scripts/run-root-coverage.ts',
    );

    const packageCalls: SpawnCalls = [];
    expect(
      await runPackageTestsModule.runPackageTests(
        [
          {
            name: 'demo',
            testsPath: 'tests/demo',
            testFiles: ['tests/demo/a.test.ts'],
            configPath: 'packages/demo/bunfig.toml',
          },
        ],
        createSpawnStub(undefined, packageCalls),
      ),
    ).toBe(0);
    expect(packageCalls[0].cmd).toEqual([
      'bun',
      'test',
      '--config',
      'packages/demo/bunfig.toml',
      'tests/demo/a.test.ts',
    ]);

    const suiteRoot = join('.tmp', 'run-coverage-script-test');
    const coverageSuites = [
      {
        name: 'root',
        testsPath: 'tests',
        coverageDir: join(suiteRoot, 'root'),
        command: ['scripts/run-root-coverage.ts'],
        ownedGlobs: ['scripts/ensure-pagefind-link.ts'],
        ignoredGlobs: [],
      },
      {
        name: 'pkg',
        testsPath: 'tests',
        coverageDir: join(suiteRoot, 'pkg'),
        command: ['scripts/run-coverage-files.ts'],
        ownedGlobs: ['scripts/examples-coverage.ts'],
        ignoredGlobs: [],
      },
    ];

    expect(
      await runCoverageModule.runCoverage(
        coverageSuites as never,
        createSpawnStub(cmd => {
          const coveragePath =
            cmd[1] === 'scripts/run-root-coverage.ts'
              ? join(suiteRoot, 'root', 'lcov.info')
              : join(suiteRoot, 'pkg', 'lcov.info');
          mkdirSync(dirname(coveragePath), { recursive: true });
          writeFileSync(
            coveragePath,
            [
              cmd[1] === 'scripts/run-root-coverage.ts'
                ? 'SF:scripts/ensure-pagefind-link.ts'
                : 'SF:scripts/examples-coverage.ts',
              'LF:1',
              'LH:1',
              'end_of_record',
              'SF:src/index.ts',
              'LF:1',
              'LH:1',
              'end_of_record',
              '',
            ].join('\n'),
            'utf8',
          );
        }),
      ),
    ).toBe(0);
    expect(readFileSync(join(suiteRoot, 'root', 'lcov.info'), 'utf8')).not.toContain('SF:src/index.ts');
    expect(readFileSync(join(suiteRoot, 'pkg', 'lcov.info'), 'utf8')).toContain(
      'SF:scripts/examples-coverage.ts',
    );

    rmSync('coverage', { recursive: true, force: true });
    rmSync(join('.tmp', 'run-coverage-script-test'), { recursive: true, force: true });
  });

  test('checks coverage summaries and docker env wiring', async () => {
    const checkCoverageModule = await import(`../../scripts/check-coverage.ts?check=${Date.now()}`);
    const dockerModule = await import(`../../scripts/run-docker-tests.ts?docker=${Date.now()}`);

    const coverageDir = join(tempDir, 'cov-suite');
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(
      join(coverageDir, 'lcov.info'),
      'SF:scripts/ensure-pagefind-link.ts\nFN:1,ensurePagefindLink\nFNDA:1,ensurePagefindLink\nDA:1,1\nLF:1\nLH:1\nend_of_record\n',
      'utf8',
    );

    const failures = await checkCoverageModule.checkCoverage(
      [
        {
          name: 'tooling',
          testsPath: 'tests',
          coverageDir,
          command: [],
          ownedGlobs: ['scripts/ensure-pagefind-link.ts'],
          ignoredGlobs: [],
        },
      ] as never,
      { error() {}, log() {} },
    );
    expect(failures).toEqual([]);
    expect(checkCoverageModule.percent(5, 10)).toBe(50);
    expect(checkCoverageModule.formatPercent(1, 2)).toBe('50.0% (1/2)');

    const dockerEnv = dockerModule.getDockerEnv({ POSTGRES_URL: 'postgres://custom' });
    expect(dockerEnv.TEST_POSTGRES_URL).toBe('postgres://custom');

    const dockerCalls: SpawnCalls = [];
    expect(
      await dockerModule.runDockerTests(
        [{ label: 'docker-step', command: ['bun', 'test', 'tests/docker'] }],
        createSpawnStub(undefined, dockerCalls),
        dockerEnv,
      ),
    ).toBe(0);
    expect(dockerCalls[0].env?.POSTGRES_URL).toBe('postgres://custom');
  });
});

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TestCommandSuite {
  name: string;
  testsPath: string;
  configPath?: string;
}

export interface CoverageSuite extends TestCommandSuite {
  coverageDir: string;
  command: string[];
  ownedGlobs: string[];
  ignoredGlobs: string[];
}

const coverageReporterArgs = ['--coverage-reporter', 'text', '--coverage-reporter', 'lcov'] as const;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function packageSuites(): TestCommandSuite[] {
  const packagesDir = join(process.cwd(), 'packages');
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return entries
    .filter(name => existsSync(join(packagesDir, name, 'tests')))
    .map(name => {
      const testsPath = normalizePath(join('packages', name, 'tests'));
      const configPath = normalizePath(join('packages', name, 'bunfig.toml'));
      return {
        name,
        testsPath,
        configPath: existsSync(join(process.cwd(), configPath)) ? configPath : undefined,
      };
    });
}

function activeSuiteFilter(): Set<string> | null {
  const raw = Bun.env.SLINGSHOT_SUITE_FILTER;
  if (raw == null || raw.trim().length === 0) return null;
  return new Set(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(value => value.length > 0),
  );
}

function applySuiteFilter<T extends { name: string }>(suites: T[]): T[] {
  const filter = activeSuiteFilter();
  if (filter == null) return suites;
  return suites.filter(suite => filter.has(suite.name));
}

export const rootCoverageOwnedGlobs = [
  'src/**/*.ts',
  'src/**/*.tsx',
  'scripts/**/*.ts',
  'scripts/**/*.tsx',
  'tsup.cli.config.ts',
  'vitest.config.ts',
];

export const rootCoverageIgnoredGlobs = [
  '**/*.d.ts',
  '**/node_modules/**',
  'tests/**',
  'examples/**',
  'coverage/**',
  'dist/**',
  'packages/**',
  '.tmp/**',
  '.tmp-generated-*/**',
];

export const rootCoverageSuite: CoverageSuite = {
  name: 'root',
  testsPath: 'tests',
  coverageDir: 'coverage/root',
  command: ['scripts/run-root-coverage.ts'],
  ownedGlobs: rootCoverageOwnedGlobs,
  ignoredGlobs: rootCoverageIgnoredGlobs,
};

export const packageTestSuites = applySuiteFilter(packageSuites());

export const coverageSuites: CoverageSuite[] = [
  rootCoverageSuite,
  ...packageTestSuites.map(testSuite => ({
    ...testSuite,
    coverageDir: `coverage/${testSuite.name}`,
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      `coverage/${testSuite.name}`,
      ...(testSuite.configPath ? ['--config', testSuite.configPath] : []),
      testSuite.testsPath,
    ],
    ownedGlobs: [`packages/${testSuite.name}/**/*.ts`, `packages/${testSuite.name}/**/*.tsx`],
    ignoredGlobs: [
      `packages/${testSuite.name}/node_modules/**`,
      `packages/${testSuite.name}/tests/**`,
      `packages/${testSuite.name}/dist/**`,
      `packages/${testSuite.name}/coverage/**`,
      `packages/${testSuite.name}/**/*.d.ts`,
    ],
  })),
].filter(suite => {
  const filter = activeSuiteFilter();
  return filter == null || filter.has(suite.name);
});

export function coverageArtifactPath(suite: CoverageSuite): string {
  return `${suite.coverageDir}/lcov.info`;
}

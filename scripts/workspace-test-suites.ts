import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TestCommandSuite {
  name: string;
  testsPath: string;
  testFiles?: string[];
  configPath?: string;
}

export interface CoverageSuite extends TestCommandSuite {
  coverageDir: string;
  command: string[];
  ownedGlobs: string[];
  ignoredGlobs: string[];
}

const coverageReporterArgs = [
  '--coverage-reporter',
  'text',
  '--coverage-reporter',
  'lcov',
] as const;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function collectPackageTestFiles(testsDir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    const fullPath = join(testsDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectPackageTestFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.test\.tsx?$/.test(entry.name)) continue;

    files.push(normalizePath(fullPath));
  }

  return files.sort((a, b) => a.localeCompare(b));
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
      const testFiles = collectPackageTestFiles(join(packagesDir, name, 'tests'));
      const configPath = normalizePath(join('packages', name, 'bunfig.toml'));
      return {
        name,
        testsPath,
        testFiles,
        configPath: existsSync(join(process.cwd(), configPath)) ? configPath : undefined,
      };
    });
}

interface PackageCoverageOverride {
  coverageTestFiles: string[];
  configPath?: string;
  coverageCommand?: string[];
}

const packageCoverageOverrides: Record<string, PackageCoverageOverride> = {
  'slingshot-auth': {
    coverageTestFiles: [
      'tests/isolated/csrf-signing-singleton.test.ts',
      'tests/isolated/jwt-signing-singleton.test.ts',
      'tests/isolated/memoryCache.test.ts',
      'tests/isolated/passkey-e2e.test.ts',
      'tests/isolated/saml-login-parity.test.ts',
    ],
  },
  'slingshot-bullmq': {
    coverageTestFiles: ['tests/isolated/bullmq-adapter-durable.test.ts'],
  },
  'slingshot-ssr': {
    coverageTestFiles: ['tests/isolated/ssr-windows-path-resolution.test.ts'],
  },
  'slingshot-webhooks': {
    coverageTestFiles: [
      'tests/isolated/webhooks-bullmq.test.ts',
      'tests/isolated/webhooks-bullmq-ioredis.test.ts',
      'tests/isolated/webhooks-bullmq-missing-bullmq.test.ts',
      'tests/isolated/webhooks-bullmq-missing-ioredis.test.ts',
    ],
  },
  'runtime-node': {
    coverageTestFiles: [],
    coverageCommand: ['scripts/run-runtime-node-coverage.ts'],
  },
};

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

function packageCoverageSuites(): CoverageSuite[] {
  const packagesDir = join(process.cwd(), 'packages');
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return entries.flatMap(name => {
    const testsDir = join(packagesDir, name, 'tests');
    const packageTests = existsSync(testsDir) ? collectPackageTestFiles(testsDir) : [];
    const override = packageCoverageOverrides[name];
    const coverageTestFiles = Array.from(
      new Set([...packageTests, ...(override?.coverageTestFiles ?? [])]),
    ).sort((a, b) => a.localeCompare(b));

    if (coverageTestFiles.length === 0) {
      return [];
    }

    const defaultConfigPath = normalizePath(join('packages', name, 'bunfig.toml'));
    const configPath =
      override?.configPath ??
      (existsSync(join(process.cwd(), defaultConfigPath)) ? defaultConfigPath : undefined);

    return [
      {
        name,
        testsPath: normalizePath(join('packages', name, 'tests')),
        testFiles: packageTests.length > 0 ? packageTests : undefined,
        configPath,
        coverageDir: `coverage/${name}`,
        command: override?.coverageCommand ?? [
          'scripts/run-coverage-files.ts',
          '--label',
          name,
          '--coverage-dir',
          `coverage/${name}`,
          ...(configPath ? ['--config', configPath] : []),
          ...coverageTestFiles,
        ],
        ownedGlobs: [`packages/${name}/**/*.ts`, `packages/${name}/**/*.tsx`],
        ignoredGlobs: [
          `packages/${name}/node_modules/**`,
          `packages/${name}/tests/**`,
          `packages/${name}/dist/**`,
          `packages/${name}/coverage/**`,
          `packages/${name}/**/*.d.ts`,
        ],
      },
    ];
  });
}

export const coverageSuites: CoverageSuite[] = [
  rootCoverageSuite,
  ...packageCoverageSuites(),
].filter(suite => {
  const filter = activeSuiteFilter();
  return filter == null || filter.has(suite.name);
});

export function coverageArtifactPath(suite: CoverageSuite): string {
  return `${suite.coverageDir}/lcov.info`;
}

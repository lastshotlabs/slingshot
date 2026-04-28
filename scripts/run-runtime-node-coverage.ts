import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLcovArtifacts, waitForCoverageArtifacts } from './coverage-lcov';

async function collectFiles(pattern: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob(pattern).scan({ cwd: process.cwd(), onlyFiles: true })) {
    files.push(file.replace(/\\/g, '/'));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function runCommand(
  label: string,
  cmd: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  console.log(`test:coverage:${label}`);
  const proc = spawnFn(cmd, {
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

export async function runRuntimeNodeCoverage(
  spawnFn: typeof Bun.spawn = Bun.spawn,
  coverageDir = 'coverage/runtime-node',
): Promise<number> {
  const runsDir = mkdtempSync(join(tmpdir(), 'slingshot-runtime-node-coverage-'));
  const vitestCoverageDir = join(runsDir, 'vitest');
  const artifacts: string[] = [];
  let exitCode = 0;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });

  const packageTests = (await collectFiles('packages/runtime-node/tests/**/*.test.ts')).filter(
    file => !file.includes('/tests/node-runtime/'),
  );
  const nodeTests = await collectFiles('tests/node-runtime/**/*.test.ts');

  if (packageTests.length > 0) {
    const code = await runCommand(
      'runtime-node:bun-smoke',
      [process.execPath, 'test', ...packageTests],
      spawnFn,
    );
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  if (nodeTests.length > 0) {
    const code = await runCommand(
      'runtime-node:vitest',
      [
        process.execPath,
        'x',
        'vitest',
        'run',
        '--config',
        'vitest.config.ts',
        '--coverage.enabled',
        '--coverage.provider',
        'v8',
        '--coverage.reporter',
        'text',
        '--coverage.reporter',
        'lcov',
        '--coverage.reportsDirectory',
        vitestCoverageDir,
        '--coverage.include',
        'packages/runtime-node/src/**/*.ts',
        ...nodeTests,
      ],
      spawnFn,
    );
    artifacts.push(join(vitestCoverageDir, 'lcov.info'));
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  const missingArtifacts = await waitForCoverageArtifacts(artifacts);
  if (missingArtifacts.length > 0) {
    console.error(
      `[coverage] Missing runtime-node LCOV artifact(s): ${missingArtifacts.join(', ')}`,
    );
    if (exitCode === 0) {
      exitCode = 1;
    }
  }

  try {
    mergeLcovArtifacts(artifacts, join(coverageDir, 'lcov.info'));
    return exitCode;
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await runRuntimeNodeCoverage());
}

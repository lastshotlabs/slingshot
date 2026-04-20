import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeLcovArtifacts } from './coverage-lcov';

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
): Promise<number> {
  const coverageDir = 'coverage/runtime-node';
  const vitestCoverageDir = join(coverageDir, '.runs', 'vitest');
  const artifacts: string[] = [];
  let exitCode = 0;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });

  const packageTests = await collectFiles('packages/runtime-node/tests/**/*.test.ts');
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

  mergeLcovArtifacts(artifacts, join(coverageDir, 'lcov.info'));
  return exitCode;
}

if (import.meta.main) {
  process.exit(await runRuntimeNodeCoverage());
}

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

export async function runOrchestrationCoverage(
  spawnFn: typeof Bun.spawn = Bun.spawn,
  coverageDir = 'coverage/slingshot-orchestration',
): Promise<number> {
  const runsDir = mkdtempSync(join(tmpdir(), 'slingshot-orchestration-coverage-'));
  const bunCoverageDir = join(runsDir, 'bun');
  const artifacts = [join(bunCoverageDir, 'lcov.info')];
  let exitCode = 0;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });

  const packageTests = await collectFiles('packages/slingshot-orchestration/tests/**/*.test.ts');
  if (packageTests.length > 0) {
    const code = await runCommand(
      'slingshot-orchestration:bun',
      [
        process.execPath,
        'scripts/run-coverage-files.ts',
        '--label',
        'slingshot-orchestration',
        '--coverage-dir',
        bunCoverageDir,
        ...packageTests,
      ],
      spawnFn,
    );
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  const nodeTests = (await collectFiles('tests/node-runtime/**/*.test.ts')).filter(file =>
    file.endsWith('/orchestration-sqlite.test.ts'),
  );
  if (nodeTests.length > 0) {
    const code = await runCommand(
      'slingshot-orchestration:vitest-sqlite',
      [process.execPath, 'x', 'vitest', 'run', '--config', 'vitest.config.ts', ...nodeTests],
      spawnFn,
    );
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  const missingArtifacts = await waitForCoverageArtifacts(artifacts);
  if (missingArtifacts.length > 0) {
    console.error(
      `[coverage] Missing orchestration LCOV artifact(s): ${missingArtifacts.join(', ')}`,
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
  process.exit(await runOrchestrationCoverage());
}

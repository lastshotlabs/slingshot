import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLcovArtifacts, waitForCoverageArtifacts } from './coverage-lcov';
import { collectRootCoverageTestFiles, partitionRootTestFiles } from './root-test-files';

export async function runRootCoverage(
  files?: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
  coverageDir = 'coverage/root',
): Promise<number> {
  const resolvedFiles = files ?? (await collectRootCoverageTestFiles());
  if (resolvedFiles.length === 0) {
    return 0;
  }

  const chunkSize = 40;
  const { bulk, isolated } = partitionRootTestFiles(resolvedFiles);
  const artifacts: string[] = [];
  let runCounter = 0;
  let exitCode = 0;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });
  const runsDir = mkdtempSync(join(tmpdir(), 'slingshot-root-coverage-'));

  function nextRunCoverageDir(kind: string): string {
    runCounter += 1;
    return join(runsDir, `${String(runCounter).padStart(3, '0')}-${kind}`);
  }

  for (let index = 0; index < bulk.length; index += chunkSize) {
    const chunk = bulk.slice(index, index + chunkSize);
    if (chunk.length > 0) {
      const runDir = nextRunCoverageDir(`bulk-${index / chunkSize + 1}`);
      console.log(`test:coverage:root -> bulk ${index / chunkSize + 1}`);
      const proc = spawnFn(
        [
          process.execPath,
          'test',
          '--coverage',
          '--coverage-reporter',
          'text',
          '--coverage-reporter',
          'lcov',
          '--coverage-dir',
          runDir,
          '--config',
          'bunfig.ci.toml',
          ...chunk,
        ],
        {
          cwd: process.cwd(),
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );

      const code = await proc.exited;
      artifacts.push(join(runDir, 'lcov.info'));
      if (code !== 0 && exitCode === 0) {
        exitCode = code;
      }
    }
  }

  for (const file of isolated) {
    const runDir = nextRunCoverageDir(
      `isolated-${file.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_')}`,
    );
    console.log(`test:coverage:root -> isolated ${file}`);
    const proc = spawnFn(
      [
        process.execPath,
        'test',
        '--coverage',
        '--coverage-reporter',
        'text',
        '--coverage-reporter',
        'lcov',
        '--coverage-dir',
        runDir,
        '--config',
        'bunfig.ci.toml',
        file,
      ],
      {
        cwd: process.cwd(),
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );

    const code = await proc.exited;
    artifacts.push(join(runDir, 'lcov.info'));
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  const missingArtifacts = await waitForCoverageArtifacts(artifacts);
  if (missingArtifacts.length > 0) {
    console.error(`[coverage] Missing root LCOV artifact(s): ${missingArtifacts.join(', ')}`);
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
  process.exit(await runRootCoverage());
}

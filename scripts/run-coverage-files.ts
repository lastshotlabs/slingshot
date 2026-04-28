import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLcovArtifacts, waitForCoverageArtifacts } from './coverage-lcov';
import { fileRequiresIsolatedProcess } from './root-test-files';

export interface ParsedArgs {
  coverageDir: string;
  configPath?: string;
  label: string;
  files: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const files: string[] = [];
  let coverageDir: string | null = null;
  let configPath: string | undefined;
  let label = 'suite';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--coverage-dir') {
      coverageDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--config') {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--label') {
      label = argv[index + 1] ?? label;
      index += 1;
      continue;
    }
    files.push(arg);
  }

  if (!coverageDir) {
    throw new Error('missing required --coverage-dir argument');
  }

  return { coverageDir, configPath, label, files };
}

async function runCoverage(
  suiteLabel: string,
  coverageDir: string,
  files: string[],
  configPath?: string,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  console.log(
    `test:coverage:${suiteLabel} -> ${files.length === 1 ? files[0] : `${files.length} file(s)`}`,
  );
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
      coverageDir,
      ...(configPath ? ['--config', configPath] : []),
      ...files,
    ],
    {
      cwd: process.cwd(),
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );

  return await proc.exited;
}

export async function runCoverageFiles(
  argv = process.argv.slice(2),
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  const { coverageDir, configPath, files, label } = parseArgs(argv);

  if (files.length === 0) {
    return 0;
  }

  const chunkSize = 40;
  const bulk = files.filter(file => !fileRequiresIsolatedProcess(file));
  const isolated = files.filter(file => fileRequiresIsolatedProcess(file));
  const artifacts: string[] = [];
  let runCounter = 0;
  let exitCode = 0;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });
  const runsDir = mkdtempSync(join(tmpdir(), `slingshot-coverage-${label}-`));

  function nextRunCoverageDir(kind: string): string {
    runCounter += 1;
    return join(runsDir, `${String(runCounter).padStart(3, '0')}-${kind}`);
  }

  for (let index = 0; index < bulk.length; index += chunkSize) {
    const chunk = bulk.slice(index, index + chunkSize);
    if (chunk.length > 0) {
      const runDir = nextRunCoverageDir(`bulk-${index / chunkSize + 1}`);
      const code = await runCoverage(
        `${label}:bulk:${index / chunkSize + 1}`,
        runDir,
        chunk,
        configPath,
        spawnFn,
      );
      artifacts.push(join(runDir, 'lcov.info'));
      if (code !== 0 && exitCode === 0) {
        exitCode = code;
      }
    }
  }

  for (const file of isolated) {
    const baseName = file.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_');
    const runDir = nextRunCoverageDir(`isolated-${baseName}`);
    const code = await runCoverage(`${label}:isolated`, runDir, [file], configPath, spawnFn);
    artifacts.push(join(runDir, 'lcov.info'));
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  const missingArtifacts = await waitForCoverageArtifacts(artifacts);
  if (missingArtifacts.length > 0) {
    console.error(
      `[coverage] Missing LCOV artifact(s) for ${label}: ${missingArtifacts.join(', ')}`,
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
  process.exit(await runCoverageFiles());
}

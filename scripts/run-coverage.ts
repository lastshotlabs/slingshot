import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { filterLcovContentToOwnedFiles, waitForCoverageArtifacts } from './coverage-lcov';
import { coverageArtifactPath, coverageSuites } from './workspace-test-suites';

const repoRoot = process.cwd();

export interface CoverageRunIO {
  log(message: string): void;
  stdout: { write(chunk: string | Uint8Array): unknown };
  stderr: { write(chunk: string | Uint8Array): unknown };
}

export interface CoverageFailure {
  context: string;
  testName: string;
}

export interface RunSuiteResult {
  exitCode: number;
  output: string;
}

export interface RunCoverageOptions {
  coverageRoot?: string;
}

const defaultIO: CoverageRunIO = {
  log: console.log,
  stdout: process.stdout,
  stderr: process.stderr,
};

function normalizeFailureLine(line: string): string {
  return line.replace(/\s+\[[^\]]+\]$/, '');
}

function formatCoverageContext(label: string, target: string): string {
  const bulkMatch = /^(.*):bulk:(\d+)$/.exec(label);
  if (bulkMatch) {
    return `${bulkMatch[1]} -> bulk ${bulkMatch[2]}`;
  }

  const isolatedMatch = /^(.*):isolated$/.exec(label);
  if (isolatedMatch) {
    return `${isolatedMatch[1]} -> isolated ${target}`;
  }

  if (target.length === 0) {
    return label;
  }

  return `${label} -> ${target}`;
}

async function relayAndCapture(
  stream: ReadableStream<Uint8Array> | undefined,
  writer: { write(chunk: string | Uint8Array): unknown },
): Promise<string> {
  if (!stream) {
    return '';
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    writer.write(value);
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

export function collectCoverageFailures(output: string, defaultContext: string): CoverageFailure[] {
  const failures: CoverageFailure[] = [];
  const seen = new Set<string>();
  let context = defaultContext;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const rootMatch = /^test:coverage -> (.+)$/.exec(line);
    if (rootMatch) {
      context = rootMatch[1];
      continue;
    }

    const scopedMatch = /^test:coverage:(.+) -> (.+)$/.exec(line);
    if (scopedMatch) {
      context = formatCoverageContext(scopedMatch[1], scopedMatch[2]);
      continue;
    }

    if (!line.startsWith('(fail) ')) {
      continue;
    }

    const testName = normalizeFailureLine(line.slice('(fail) '.length));
    const key = `${context}\u0000${testName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    failures.push({ context, testName });
  }

  return failures;
}

export function printCoverageFailureSummary(
  failures: CoverageFailure[],
  io: Pick<CoverageRunIO, 'log'> = defaultIO,
): void {
  if (failures.length === 0) {
    return;
  }

  const countLabel = failures.length === 1 ? '1 test' : `${failures.length} tests`;
  io.log('');
  io.log(`coverage failure summary: ${countLabel}`);
  for (const failure of failures) {
    io.log(`- [${failure.context}] ${failure.testName}`);
  }
}

export async function runSuite(
  name: string,
  command: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
  io: CoverageRunIO = defaultIO,
): Promise<RunSuiteResult> {
  io.log(`test:coverage -> ${name}`);
  const proc = spawnFn([process.execPath, ...command], {
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    relayAndCapture(proc.stdout, io.stdout),
    relayAndCapture(proc.stderr, io.stderr),
    proc.exited,
  ]);

  return {
    exitCode,
    output: `${stdout}${stderr}`,
  };
}

export async function runCoverage(
  suites = coverageSuites,
  spawnFn: typeof Bun.spawn = Bun.spawn,
  io: CoverageRunIO = defaultIO,
  options: RunCoverageOptions = {},
): Promise<number> {
  const coverageRoot = options.coverageRoot ?? 'coverage';
  rmSync(coverageRoot, { recursive: true, force: true });
  const stagedArtifacts = new Map<string, string>();
  const rawArtifacts: string[] = [];
  const failures: CoverageFailure[] = [];
  let exitCode = 0;

  for (const suite of suites) {
    const result = await runSuite(suite.name, suite.command, spawnFn, io);
    const artifactPath = coverageArtifactPath(suite);
    const missingArtifacts = await waitForCoverageArtifacts([artifactPath]);
    if (missingArtifacts.length > 0) {
      io.stderr.write(`[coverage] Missing LCOV artifact for ${suite.name}: ${artifactPath}\n`);
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
    rawArtifacts.push(existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8').trim() : '');
    failures.push(...collectCoverageFailures(result.output, suite.name));
    if (result.exitCode !== 0 && exitCode === 0) {
      exitCode = result.exitCode;
    }
  }

  rmSync(coverageRoot, { recursive: true, force: true });

  const mergedArtifact = rawArtifacts.filter(content => content.length > 0).join('\n');

  for (const suite of suites) {
    const artifactPath = coverageArtifactPath(suite);
    const content = await filterLcovContentToOwnedFiles(mergedArtifact, suite);
    stagedArtifacts.set(artifactPath, content);
  }

  for (const [artifactPath, content] of stagedArtifacts) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, content, 'utf8');
  }

  printCoverageFailureSummary(failures, io);
  return exitCode;
}

if (import.meta.main) {
  process.exit(await runCoverage());
}

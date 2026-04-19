import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { filterLcovContentToOwnedFiles } from './coverage-lcov';
import { coverageArtifactPath, coverageSuites } from './workspace-test-suites';

const repoRoot = process.cwd();

export async function runSuite(
  name: string,
  command: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  console.log(`test:coverage -> ${name}`);
  const proc = spawnFn([process.execPath, ...command], {
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

export async function runCoverage(
  suites = coverageSuites,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  rmSync('coverage', { recursive: true, force: true });
  const stagedArtifacts = new Map<string, string>();
  const rawArtifacts: string[] = [];
  let exitCode = 0;

  for (const suite of suites) {
    const code = await runSuite(suite.name, suite.command, spawnFn);
    const artifactPath = coverageArtifactPath(suite);
    rawArtifacts.push(existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8').trim() : '');
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  rmSync('coverage', { recursive: true, force: true });

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

  return exitCode;
}

if (import.meta.main) {
  process.exit(await runCoverage());
}

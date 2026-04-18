import { rmSync } from 'node:fs';
import { coverageSuites } from './coverage-suites';

const repoRoot = process.cwd();

async function runSuite(name: string, command: string[]): Promise<void> {
  console.log(`test:coverage -> ${name}`);
  const proc = Bun.spawn([process.execPath, ...command], {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
  }
}

rmSync('coverage', { recursive: true, force: true });

for (const suite of coverageSuites) {
  await runSuite(suite.name, suite.command);
}

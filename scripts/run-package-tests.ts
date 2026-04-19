import { packageTestSuites } from './workspace-test-suites';

async function runSuite(name: string, command: string[]): Promise<void> {
  console.log(`test -> ${name}`);
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
  }
}

for (const suite of packageTestSuites) {
  await runSuite(suite.name, [
    'bun',
    'test',
    ...(suite.configPath ? ['--config', suite.configPath] : []),
    ...(suite.testFiles ?? [suite.testsPath]),
  ]);
}

process.exit(0);

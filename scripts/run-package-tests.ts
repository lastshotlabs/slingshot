import { packageTestSuites } from './workspace-test-suites';
import { type TestCommandSuite } from './workspace-test-suites';

export async function runSuite(
  name: string,
  command: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  console.log(`test -> ${name}`);
  const proc = spawnFn(command, {
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

export async function runPackageTests(
  suites: TestCommandSuite[] = packageTestSuites,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  for (const suite of suites) {
    const code = await runSuite(
      suite.name,
      [
        'bun',
        'test',
        ...(suite.configPath ? ['--config', suite.configPath] : []),
        ...(suite.testFiles ?? [suite.testsPath]),
      ],
      spawnFn,
    );
    if (code !== 0) {
      return code;
    }
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await runPackageTests());
}

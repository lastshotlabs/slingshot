import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_DOCKER_POSTGRES_URL =
  'postgresql://postgres:postgres@localhost:5433/slingshot_test';

export type DockerTestCommand = { label: string; command: string[] };

const TRANSIENT_PROCESS_CRASH_CODES = new Set([132, 133, 134, 139]);

export function isTransientProcessCrashCode(code: number): boolean {
  return TRANSIENT_PROCESS_CRASH_CODES.has(code);
}

export function getRootDockerTestFiles(dir = join(process.cwd(), 'tests/docker')): string[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.test.ts'))
    .sort()
    .map(file => `tests/docker/${file}`);
}

export function createDockerTestCommands(
  rootDockerTestFiles = getRootDockerTestFiles(),
): DockerTestCommand[] {
  const rootDockerCommands = rootDockerTestFiles.map(file => ({
    label: `root docker test: ${file}`,
    command: ['bun', 'test', '--config', 'bunfig.docker.toml', '--concurrency=1', file],
  }));

  return [
    ...rootDockerCommands,
    {
      label: 'node docker tests',
      command: ['bunx', 'vitest', 'run', '--config', 'vitest.docker.config.ts'],
    },
    {
      label: 'package postgres integration tests',
      command: [
        'bun',
        'test',
        '--config',
        'bunfig.docker.toml',
        '--concurrency=1',
        'packages/slingshot-auth/tests/integration/postgres-auth.test.ts',
        'packages/slingshot-permissions/tests/integration/postgres-adapter.integration.test.ts',
      ],
    },
  ];
}

export const dockerTestCommands: DockerTestCommand[] = createDockerTestCommands();

export function getDockerEnv(env: Record<string, string | undefined> = Bun.env) {
  const dockerPostgresUrl =
    env.TEST_POSTGRES_URL ?? env.POSTGRES_URL ?? DEFAULT_DOCKER_POSTGRES_URL;
  return {
    ...env,
    TEST_POSTGRES_URL: dockerPostgresUrl,
    POSTGRES_URL: dockerPostgresUrl,
  };
}

export async function runStep(
  label: string,
  command: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
  env = getDockerEnv(),
  options: { maxCrashRetries?: number } = {},
): Promise<number> {
  const maxCrashRetries = options.maxCrashRetries ?? 1;

  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (retry ${attempt}/${maxCrashRetries})`;
    console.log(`test:docker -> ${label}${suffix}`);

    const proc = spawnFn(command, {
      cwd: process.cwd(),
      env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const code = await proc.exited;
    if (!isTransientProcessCrashCode(code) || attempt >= maxCrashRetries) {
      return code;
    }

    console.warn(`test:docker -> ${label} exited with native crash code ${code}; retrying once`);
  }
}

export async function runDockerTests(
  steps = dockerTestCommands,
  spawnFn: typeof Bun.spawn = Bun.spawn,
  env = getDockerEnv(),
): Promise<number> {
  for (const step of steps) {
    const code = await runStep(step.label, step.command, spawnFn, env);
    if (code !== 0) {
      return code;
    }
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await runDockerTests());
}

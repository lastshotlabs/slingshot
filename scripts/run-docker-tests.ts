export const DEFAULT_DOCKER_POSTGRES_URL =
  'postgresql://postgres:postgres@localhost:5433/slingshot_test';

export const dockerTestCommands: Array<{ label: string; command: string[] }> = [
  {
    label: 'root docker tests',
    command: ['bun', 'test', '--config', 'bunfig.docker.toml', '--concurrency=1', 'tests/docker/'],
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
): Promise<number> {
  console.log(`test:docker -> ${label}`);

  const proc = spawnFn(command, {
    cwd: process.cwd(),
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return await proc.exited;
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

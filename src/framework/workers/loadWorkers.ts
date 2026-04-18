import type { CronRegistryRepository, SlingshotRuntime } from '@lastshotlabs/slingshot-core';

export async function loadWorkers(opts: {
  workersDir: string;
  runtime: SlingshotRuntime;
  resolvedSecrets: Readonly<Record<string, string | undefined>>;
  persistence: { cronRegistry: CronRegistryRepository };
}): Promise<void> {
  const { workersDir, runtime, resolvedSecrets, persistence } = opts;
  const currentNames = new Set<string>();

  // Build a QueueFactory from resolved secrets so worker files receive
  // properly-credentialed infrastructure rather than reading process.env.
  let queueFactory: import('@lib/queue').QueueFactory | null = null;
  const redisHost = resolvedSecrets.redisHost;
  if (redisHost) {
    try {
      const { createQueueFactory } = await import('@lib/queue');
      queueFactory = createQueueFactory({
        host: redisHost,
        user: resolvedSecrets.redisUser,
        password: resolvedSecrets.redisPassword,
      });
    } catch {
      /* bullmq not installed — queue workers will fail at import time */
    }
  }

  // Load scheduler names saved by the previous deployment before importing
  // workers, so we can diff current vs. previous after discovery.
  const previousNames = await persistence.cronRegistry.getAll();

  for await (const file of await runtime.glob.scan('**/*.ts', { cwd: workersDir })) {
    const mod = (await import(`${workersDir}/${file}`)) as {
      default?: (factory: import('@lib/queue').QueueFactory) => Promise<string[]> | string[];
    };
    if (typeof mod.default === 'function' && queueFactory) {
      try {
        const names = await mod.default(queueFactory);
        if (Array.isArray(names)) {
          for (const name of names) currentNames.add(name);
        }
      } catch (e) {
        console.error(`[workers] error initialising worker ${file}:`, e);
      }
    }
  }

  // Persist current names for the next deployment's cleanup pass.
  await persistence.cronRegistry.save(currentNames);

  // Remove schedulers present in the previous deployment but absent from
  // the current one. knownNames is the union so cleanupStaleSchedulers
  // iterates everything it might need to remove.
  if (queueFactory) {
    const knownNames = new Set([...previousNames, ...currentNames]);
    try {
      await queueFactory.cleanupStaleSchedulers([...currentNames], knownNames);
    } catch {
      /* best-effort — bullmq not installed or Redis unavailable */
    }
  }
}

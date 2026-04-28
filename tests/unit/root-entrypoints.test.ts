import { afterEach, describe, expect, mock, test } from 'bun:test';
import { attachContext } from '@lastshotlabs/slingshot-core';

describe('root entrypoints', () => {
  afterEach(() => {
    mock.restore();
  });

  test('root package entrypoint re-exports core server and manifest helpers', async () => {
    const root = await import('../../src/index.ts');
    const server = await import('../../src/server.ts');
    const manifest = await import('../../src/lib/createServerFromManifest.ts');

    expect(root.createServer).toBe(server.createServer);
    expect(root.createServerFromManifest).toBe(manifest.createServerFromManifest);
    expect(typeof root.createApp).toBe('function');
    expect(typeof root.createMcpFoundation).toBe('function');
  });

  test('mongo, redis, and queue entrypoints expose the intended helpers', async () => {
    const mongoEntrypoint = await import('../../src/entrypoints/mongo.ts');
    const redisEntrypoint = await import('../../src/entrypoints/redis.ts');
    const queueEntrypoint = await import('../../src/entrypoints/queue.ts');
    const mongoLib = await import('../../src/lib/mongo.ts');
    const redisLib = await import('../../src/lib/redis.ts');
    const queueLib = await import('../../src/lib/queue.ts');

    expect(mongoEntrypoint.getMongoFromApp).toBe(mongoLib.getMongoFromApp);
    expect(redisEntrypoint.getRedisFromApp).toBe(redisLib.getRedisFromApp);
    expect(queueEntrypoint.createQueueFactory).toBe(queueLib.createQueueFactory);
  });

  test('testing entrypoint cookie jar absorbs, emits, and clears cookies', async () => {
    const testing = await import('../../src/testing.ts');
    const jar = testing.createCookieJar();

    jar.absorb(
      new Response('ok', {
        headers: {
          'set-cookie': 'session=abc; Path=/',
        },
      }),
    );
    jar.absorb(
      new Response('ok', {
        headers: {
          'set-cookie': 'csrf=def; Path=/',
        },
      }),
    );

    expect(jar.header()).toEqual({ cookie: 'session=abc; csrf=def' });
    jar.clear();
    expect(jar.header()).toEqual({});
  });

  test('appConfig utilities deep-freeze values and read app name from context', async () => {
    const appConfig = await import(`../../src/lib/appConfig.ts?app-config=${Date.now()}`);
    const app = { id: 'app-1' };
    attachContext(app, {
      config: { appName: 'Slingshot Test App' },
    } as any);
    const value = appConfig.deepFreeze({
      topLevel: { nested: true },
    });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.topLevel)).toBe(true);
    expect(appConfig.getAppNameFromApp(app)).toBe('Slingshot Test App');
  });

  test('resolvePlatformConfig exposes the infra helper from the CLI utilities module', async () => {
    const cliUtils = await import('../../src/cli/utils/resolvePlatformConfig.ts');

    expect(typeof cliUtils.resolvePlatformConfig).toBe('function');
  });

  test('orchestration worker command exposes Temporal manifest worker wiring', async () => {
    const WorkerCommand = (await import('../../src/cli/commands/orchestration/worker.ts')).default;
    const temporalWorkerFactory = await import(
      '../../src/lib/createTemporalOrchestrationWorkerFromManifest.ts'
    );

    expect(typeof temporalWorkerFactory.createTemporalOrchestrationWorkerFromManifest).toBe(
      'function',
    );
    expect(WorkerCommand.description).toContain('Temporal-backed Slingshot orchestration worker');
    expect(Object.keys(WorkerCommand.flags).sort()).toEqual([
      'build-id',
      'dry-run',
      'handlers',
      'manifest',
    ]);
  });
});

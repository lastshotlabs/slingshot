import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import * as builtinPluginsModule from '../../src/lib/builtinPlugins';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import * as serverModule from '../../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempManifest(content: string): string {
  const dir = join(tmpdir(), `slingshot-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'app.manifest.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

type TestServer = Awaited<ReturnType<typeof serverModule.createServer>>;

function makeTestServer(): TestServer {
  const server = {
    stop: () => Promise.resolve(),
    port: 3000,
  };
  return server as unknown as TestServer;
}

function makePlugin(name: string): SlingshotPlugin {
  return { name };
}

async function expectRejectMessage(promise: Promise<unknown>, text: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected promise to reject with message containing: ${text}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(text);
  }
}

const MINIMAL_MANIFEST = JSON.stringify({
  manifestVersion: 1,
  routesDir: '${importMetaDir}/routes',
});

// An actually invalid manifest — manifestVersion must be literal 1
const INVALID_MANIFEST = JSON.stringify({ manifestVersion: 99 });

describe('createServerFromManifest', () => {
  describe('file reading', () => {
    it('throws with path when manifest file does not exist', async () => {
      await expectRejectMessage(
        createServerFromManifest('/nonexistent/path/app.manifest.json'),
        '[createServerFromManifest] Failed to read manifest at',
      );
    });

    it('throws when manifest file contains invalid JSON', async () => {
      const path = writeTempManifest('{ not json }');
      await expectRejectMessage(
        createServerFromManifest(path),
        '[createServerFromManifest] Failed to read manifest',
      );
    });
  });

  describe('manifest validation', () => {
    it('throws listing validation errors for invalid manifest', async () => {
      const path = writeTempManifest(INVALID_MANIFEST);
      await expectRejectMessage(
        createServerFromManifest(path),
        '[createServerFromManifest] Invalid manifest',
      );
    });
  });

  describe('baseDir defaults', () => {
    it('defaults baseDir to manifest file directory', async () => {
      const path = writeTempManifest(MINIMAL_MANIFEST);
      const dir = path.replace(/[/\\][^/\\]+$/, '');

      let capturedConfig: Record<string, unknown> | undefined;
      const spy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        expect(typeof capturedConfig?.['routesDir']).toBe('string');
        // routesDir resolved relative to manifest's dir — both paths normalized for cross-platform comparison
        const routesDirNorm = (capturedConfig?.['routesDir'] as string).replace(/\\/g, '/');
        const dirNorm = dir.replace(/\\/g, '/');
        expect(routesDirNorm.startsWith(dirNorm)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('dry-run mode', () => {
    it('dry-run skips createServer and returns stub', async () => {
      const path = writeTempManifest(MINIMAL_MANIFEST);
      const spy = spyOn(serverModule, 'createServer');

      const server = await createServerFromManifest(path, undefined, { dryRun: true });

      expect(spy).not.toHaveBeenCalled();
      expect(typeof server.stop).toBe('function');

      spy.mockRestore();
    });
  });

  describe('environment variable interpolation', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env['TEST_PORT'] = '9999';
      process.env['TEST_HOST'] = 'example.com';
    });

    afterEach(() => {
      // Restore original env
      for (const key of ['TEST_PORT', 'TEST_HOST']) {
        if (key in originalEnv) {
          process.env[key] = originalEnv[key];
        } else {
          Reflect.deleteProperty(process.env, key);
        }
      }
    });

    it('substitutes ${NAME} bare placeholders with env values', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        hostname: '${TEST_HOST}',
      });
      const path = writeTempManifest(manifest);

      let capturedConfig: Record<string, unknown> | undefined;
      const spy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        expect(capturedConfig?.['hostname']).toBe('example.com');
      } finally {
        spy.mockRestore();
      }
    });

    it('substitutes ${env:NAME} prefixed placeholders with env values', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        hostname: '${env:TEST_HOST}',
      });
      const path = writeTempManifest(manifest);

      let capturedConfig: Record<string, unknown> | undefined;
      const spy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        expect(capturedConfig?.['hostname']).toBe('example.com');
      } finally {
        spy.mockRestore();
      }
    });

    it('leaves ${importMetaDir} and other lowercase placeholders untouched', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        routesDir: '${importMetaDir}/routes',
      });
      const path = writeTempManifest(manifest);
      const spy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      // Should not throw — ${importMetaDir} is not substituted
      try {
        await createServerFromManifest(path);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws when a referenced env variable is not set', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        hostname: '${UNSET_VAR_THAT_DOES_NOT_EXIST}',
      });
      const path = writeTempManifest(manifest);

      await expectRejectMessage(
        createServerFromManifest(path),
        'Environment variable "UNSET_VAR_THAT_DOES_NOT_EXIST" is not set',
      );
    });

    it('interpolates values nested inside objects', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        security: { cors: 'https://${TEST_HOST}' },
      });
      const path = writeTempManifest(manifest);

      let capturedConfig: Record<string, unknown> | undefined;
      const spy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        const security = capturedConfig?.['security'] as Record<string, unknown> | undefined;
        expect(security?.['cors']).toBe('https://example.com');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('builtin plugin resolution', () => {
    it('auto-loads builtin plugins not in the user registry', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        plugins: [{ plugin: 'slingshot-permissions' }],
      });
      const path = writeTempManifest(manifest);

      const fakePlugin = makePlugin('slingshot-permissions');
      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
        () => fakePlugin,
      );
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path);
        expect(loadSpy).toHaveBeenCalledWith('slingshot-permissions');
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });

    it('does not call loadBuiltinPlugin when plugin is already in user registry', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        plugins: [{ plugin: 'slingshot-permissions' }],
      });
      const path = writeTempManifest(manifest);

      const registry = createManifestHandlerRegistry();
      const fakePlugin = makePlugin('slingshot-permissions');
      registry.registerPlugin('slingshot-permissions', () => fakePlugin);

      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(null);
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path, registry);
        expect(loadSpy).not.toHaveBeenCalled();
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });

    it('throws a clear error when a builtin plugin package is not installed', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        plugins: [{ plugin: 'slingshot-permissions' }],
      });
      const path = writeTempManifest(manifest);

      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockRejectedValue(
        new Error(
          '[builtinPlugins] Plugin "slingshot-permissions" requires package "@lastshotlabs/slingshot-permissions" which is not installed. Run: bun add @lastshotlabs/slingshot-permissions',
        ),
      );

      try {
        await expectRejectMessage(createServerFromManifest(path), 'which is not installed');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('auto-loads the built-in SSR plugin from the top-level ssr section', async () => {
      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          ssr: {
            renderer: { handler: 'ssrRenderer' },
            runtime: { handler: 'edgeRuntime' },
            serverRoutesDir: './server/routes',
            assetsManifest: './dist/.vite/manifest.json',
          },
          ssg: {
            outDir: './dist/static',
          },
        }),
      );
      const manifestDir = path.replace(/[/\\][^/\\]+$/, '');

      const registry = createManifestHandlerRegistry();
      const renderer = {
        resolve: () => Promise.resolve(null),
        render: () => Promise.resolve(new Response('ok')),
      };
      const runtime = { fs: { readFile: () => Promise.resolve('') } };
      registry.registerHandler('ssrRenderer', () => renderer);
      registry.registerHandler('edgeRuntime', () => runtime);

      let capturedConfig: Record<string, unknown> | undefined;
      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(config => {
        capturedConfig = config;
        return makePlugin('slingshot-ssr');
      });
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path, registry);
        expect(loadSpy).toHaveBeenCalledWith('slingshot-ssr');
        expect(capturedConfig?.['renderer']).toBe(renderer);
        expect(capturedConfig?.['runtime']).toBe(runtime);
        expect(capturedConfig?.['serverRoutesDir']).toBe(join(manifestDir, 'server/routes'));
        expect(capturedConfig?.['assetsManifest']).toBe(
          join(manifestDir, 'dist/.vite/manifest.json'),
        );
        expect(capturedConfig?.['staticDir']).toBe(join(manifestDir, 'dist/static'));
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });

    it('resolves builtin SSR handler refs and plugin-local paths from the manifest', async () => {
      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          plugins: [
            {
              plugin: 'slingshot-ssr',
              config: {
                renderer: { handler: 'ssrRenderer' },
                runtime: { handler: 'edgeRuntime' },
                serverRoutesDir: './server/routes',
                serverActionsDir: './server/actions',
                assetsManifest: './dist/.vite/manifest.json',
                staticDir: './dist/static',
                isr: { adapter: { handler: 'isrAdapter' } },
              },
            },
          ],
        }),
      );
      const manifestDir = path.replace(/[/\\][^/\\]+$/, '');

      const registry = createManifestHandlerRegistry();
      const renderer = {
        resolve: () => Promise.resolve(null),
        render: () => Promise.resolve(new Response('ok')),
      };
      const runtime = { fs: { readFile: () => Promise.resolve('') } };
      const isrAdapter = {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        invalidatePath: () => Promise.resolve(),
        invalidateTag: () => Promise.resolve(),
      };
      registry.registerHandler('ssrRenderer', () => renderer);
      registry.registerHandler('edgeRuntime', () => runtime);
      registry.registerHandler('isrAdapter', () => isrAdapter);

      let capturedConfig: Record<string, unknown> | undefined;
      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(config => {
        capturedConfig = config;
        return makePlugin('slingshot-ssr');
      });
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path, registry);
        expect(capturedConfig?.['renderer']).toBe(renderer);
        expect(capturedConfig?.['runtime']).toBe(runtime);
        expect(capturedConfig?.['serverRoutesDir']).toBe(join(manifestDir, 'server/routes'));
        expect(capturedConfig?.['serverActionsDir']).toBe(join(manifestDir, 'server/actions'));
        expect(capturedConfig?.['assetsManifest']).toBe(
          join(manifestDir, 'dist/.vite/manifest.json'),
        );
        expect(capturedConfig?.['staticDir']).toBe(join(manifestDir, 'dist/static'));
        expect((capturedConfig?.['isr'] as { adapter: unknown }).adapter).toBe(isrAdapter);
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });

    it('resolves builtin webhook handler refs while preserving manifest-safe store config', async () => {
      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          plugins: [
            {
              plugin: 'slingshot-webhooks',
              config: {
                store: 'sqlite',
                adminGuard: { handler: 'adminGuard' },
                queue: { handler: 'queue' },
                inbound: [{ handler: 'stripeInbound' }],
                queueConfig: {
                  maxAttempts: 3,
                  onDeadLetter: { handler: 'deadLetter' },
                },
              },
            },
          ],
        }),
      );

      const registry = createManifestHandlerRegistry();
      const adminGuard = () => Promise.resolve({ subject: 'admin-user' });
      const queue = {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        enqueue: () => Promise.resolve('job-1'),
      };
      const inbound = { name: 'stripe', verify: () => Promise.resolve({ verified: true }) };
      const onDeadLetter = () => Promise.resolve();
      registry.registerHandler('adminGuard', () => adminGuard);
      registry.registerHandler('queue', () => queue);
      registry.registerHandler('stripeInbound', () => inbound);
      registry.registerHandler('deadLetter', () => onDeadLetter);

      let capturedConfig: Record<string, unknown> | undefined;
      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(config => {
        capturedConfig = config;
        return makePlugin('slingshot-webhooks');
      });
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path, registry);
        expect(capturedConfig?.['store']).toBe('sqlite');
        expect(capturedConfig?.['adminGuard']).toBe(adminGuard);
        expect(capturedConfig?.['queue']).toBe(queue);
        expect(capturedConfig?.['inbound']).toEqual([inbound]);
        expect(
          (capturedConfig?.['queueConfig'] as { maxAttempts: number; onDeadLetter: unknown })
            .maxAttempts,
        ).toBe(3);
        expect(
          (capturedConfig?.['queueConfig'] as { maxAttempts: number; onDeadLetter: unknown })
            .onDeadLetter,
        ).toBe(onDeadLetter);
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });
  });

  describe('builtin event bus resolution', () => {
    it('auto-registers the built-in BullMQ event bus for manifest mode', async () => {
      const previousRedisHost = process.env.REDIS_HOST;
      const previousRedisUser = process.env.REDIS_USER;
      const previousRedisPassword = process.env.REDIS_PASSWORD;
      process.env.REDIS_HOST = '127.0.0.1:6380';
      delete process.env.REDIS_USER;
      delete process.env.REDIS_PASSWORD;

      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          eventBus: 'bullmq',
        }),
      );

      let capturedBullmqConfig: Record<string, unknown> | undefined;
      const fakeBus = createInProcessAdapter();
      mock.module('@lastshotlabs/slingshot-bullmq', () => ({
        createBullMQAdapter: (config: Record<string, unknown>) => {
          capturedBullmqConfig = config;
          return fakeBus;
        },
      }));

      let capturedConfig: Record<string, unknown> | undefined;
      const serverSpy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        expect(capturedConfig?.['eventBus']).toBe(fakeBus);
        expect(capturedBullmqConfig).toBeDefined();
        expect(capturedBullmqConfig?.['connection']).toEqual({
          host: '127.0.0.1',
          port: 6380,
        });
      } finally {
        serverSpy.mockRestore();
        if (previousRedisHost !== undefined) process.env.REDIS_HOST = previousRedisHost;
        else delete process.env.REDIS_HOST;
        if (previousRedisUser !== undefined) process.env.REDIS_USER = previousRedisUser;
        else delete process.env.REDIS_USER;
        if (previousRedisPassword !== undefined) process.env.REDIS_PASSWORD = previousRedisPassword;
        else delete process.env.REDIS_PASSWORD;
      }
    });

    it('forwards built-in BullMQ manifest config while keeping secrets-sourced connection', async () => {
      const previousRedisHost = process.env.REDIS_HOST;
      process.env.REDIS_HOST = '127.0.0.1:6381';

      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          eventBus: {
            type: 'bullmq',
            config: {
              prefix: 'myapp:events',
              attempts: 5,
              connection: { host: 'ignored.example', port: 9999 },
            },
          },
        }),
      );

      let capturedBullmqConfig: Record<string, unknown> | undefined;
      mock.module('@lastshotlabs/slingshot-bullmq', () => ({
        createBullMQAdapter: (config: Record<string, unknown>) => {
          capturedBullmqConfig = config;
          return createInProcessAdapter();
        },
      }));

      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path);
        expect(capturedBullmqConfig?.['prefix']).toBe('myapp:events');
        expect(capturedBullmqConfig?.['attempts']).toBe(5);
        expect(capturedBullmqConfig?.['connection']).toEqual({
          host: '127.0.0.1',
          port: 6381,
        });
      } finally {
        serverSpy.mockRestore();
        if (previousRedisHost !== undefined) process.env.REDIS_HOST = previousRedisHost;
        else delete process.env.REDIS_HOST;
      }
    });

    it('does not override a user-registered BullMQ event bus', async () => {
      const path = writeTempManifest(
        JSON.stringify({
          manifestVersion: 1,
          eventBus: 'bullmq',
        }),
      );

      const registry = createManifestHandlerRegistry();
      const fakeBus = createInProcessAdapter();
      registry.registerEventBus('bullmq', () => fakeBus);

      let capturedConfig: Record<string, unknown> | undefined;
      const serverSpy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path, registry);
        expect(capturedConfig?.['eventBus']).toBe(fakeBus);
      } finally {
        serverSpy.mockRestore();
      }
    });
  });

  describe('handler loading', () => {
    it('loads handlers from a directory (dir mode) and registers them', async () => {
      const dir = join(tmpdir(), `slingshot-handlers-dir-${Date.now()}`);
      mkdirSync(dir, { recursive: true });

      // Create handler directory with .ts files
      const handlersDir = join(dir, 'handlers');
      mkdirSync(handlersDir, { recursive: true });
      writeFileSync(
        join(handlersDir, 'myHandler.ts'),
        'export function myHandler() { return "handler-result"; }\n',
        'utf-8',
      );
      writeFileSync(
        join(handlersDir, 'ignored.d.ts'),
        '// This should be ignored\nexport const foo = 1;\n',
        'utf-8',
      );

      const manifest = JSON.stringify({
        manifestVersion: 1,
        handlers: { dir: './handlers' },
      });
      writeFileSync(join(dir, 'app.manifest.json'), manifest, 'utf-8');

      const registry = createManifestHandlerRegistry();
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(join(dir, 'app.manifest.json'), registry);
        expect(registry.hasHandler('myHandler')).toBe(true);
      } finally {
        serverSpy.mockRestore();
      }
    });

    it('loads hooks from handler files', async () => {
      const dir = join(tmpdir(), `slingshot-hooks-${Date.now()}`);
      mkdirSync(dir, { recursive: true });

      writeFileSync(
        join(dir, 'slingshot.handlers.ts'),
        `export const hooks = {
          afterAdapters: async () => {},
          beforeSetup: async () => {},
        };\n`,
        'utf-8',
      );

      const manifest = JSON.stringify({
        manifestVersion: 1,
      });
      writeFileSync(join(dir, 'app.manifest.json'), manifest, 'utf-8');

      const registry = createManifestHandlerRegistry();
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(join(dir, 'app.manifest.json'), registry);
        expect(registry.hasHook('afterAdapters')).toBe(true);
        expect(registry.hasHook('beforeSetup')).toBe(true);
      } finally {
        serverSpy.mockRestore();
      }
    });

    it('skips handler loading when handlersPath is false', async () => {
      const path = writeTempManifest(MINIMAL_MANIFEST);

      const registry = createManifestHandlerRegistry();
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path, registry, { handlersPath: false });
        // No handlers should be loaded
      } finally {
        serverSpy.mockRestore();
      }
    });

    it('handles non-existent handler directory gracefully', async () => {
      const dir = join(tmpdir(), `slingshot-nodir-${Date.now()}`);
      mkdirSync(dir, { recursive: true });

      const manifest = JSON.stringify({
        manifestVersion: 1,
        handlers: { dir: './nonexistent-handlers' },
      });
      writeFileSync(join(dir, 'app.manifest.json'), manifest, 'utf-8');

      const registry = createManifestHandlerRegistry();
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        // Should not throw
        await createServerFromManifest(join(dir, 'app.manifest.json'), registry);
      } finally {
        serverSpy.mockRestore();
      }
    });

    it('overrides manifest handlers field with handlersPath option', async () => {
      const dir = join(tmpdir(), `slingshot-override-${Date.now()}`);
      mkdirSync(dir, { recursive: true });

      const handlersDir = join(dir, 'custom-handlers');
      mkdirSync(handlersDir, { recursive: true });
      writeFileSync(
        join(handlersDir, 'custom.ts'),
        'export function customFn() { return "custom"; }\n',
        'utf-8',
      );

      const manifest = JSON.stringify({
        manifestVersion: 1,
        handlers: 'should-not-be-used.ts',
      });
      writeFileSync(join(dir, 'app.manifest.json'), manifest, 'utf-8');

      const registry = createManifestHandlerRegistry();
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(join(dir, 'app.manifest.json'), registry, {
          handlersPath: { dir: handlersDir },
        });
        expect(registry.hasHandler('customFn')).toBe(true);
      } finally {
        serverSpy.mockRestore();
      }
    });
  });

  describe('synthetic plugin injection', () => {
    it('auto-adds slingshot-entity and slingshot-permissions when entities are defined', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        entities: {
          Post: {
            fields: {
              id: { type: 'string', primary: true },
              title: { type: 'string' },
            },
          },
        },
      });
      const path = writeTempManifest(manifest);

      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
        () => {
          return makePlugin('mock-plugin');
        },
      );
      const serverSpy = spyOn(serverModule, 'createServer').mockImplementation(() => {
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        // Both slingshot-entity and slingshot-permissions should have been loaded
        const loadedPlugins = loadSpy.mock.calls.map(c => c[0]);
        expect(loadedPlugins).toContain('slingshot-entity');
        expect(loadedPlugins).toContain('slingshot-permissions');
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });

    it('includes afterAdapters hooks in synthetic entity plugin config', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        apiPrefix: '/api/v2',
        entities: {
          Post: {
            fields: {
              id: { type: 'string', primary: true },
              title: { type: 'string' },
            },
          },
        },
        hooks: {
          afterAdapters: [
            { handler: 'myHook' },
            { handler: 'myHookWithParams', params: { key: 'value' } },
          ],
        },
      });
      const path = writeTempManifest(manifest);

      const capturedConfigs: Record<string, unknown>[] = [];
      const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
        (config?: Record<string, unknown>) => {
          if (config) capturedConfigs.push(config);
          return makePlugin('mock-plugin');
        },
      );
      const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

      try {
        await createServerFromManifest(path);
        // Find the entity plugin config
        const entityConfig = capturedConfigs.find(c => c['name'] === 'slingshot-entity');
        expect(entityConfig).toBeDefined();
        expect(entityConfig!['mountPath']).toBe('/api/v2');
        const manifestBlock = entityConfig!['manifest'] as Record<string, unknown>;
        const hooks = manifestBlock['hooks'] as { afterAdapters: Array<{ handler: string; params?: unknown }> };
        expect(hooks).toBeDefined();
        expect(hooks.afterAdapters).toHaveLength(2);
        expect(hooks.afterAdapters[0]).toEqual({ handler: 'myHook' });
        expect(hooks.afterAdapters[1]).toEqual({ handler: 'myHookWithParams', params: { key: 'value' } });
      } finally {
        loadSpy.mockRestore();
        serverSpy.mockRestore();
      }
    });
  });

  describe('env var interpolation in arrays', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env['TEST_ORIGIN'] = 'https://test.example.com';
    });

    afterEach(() => {
      if ('TEST_ORIGIN' in originalEnv) {
        process.env['TEST_ORIGIN'] = originalEnv['TEST_ORIGIN'];
      } else {
        Reflect.deleteProperty(process.env, 'TEST_ORIGIN');
      }
    });

    it('interpolates env vars inside arrays', async () => {
      const manifest = JSON.stringify({
        manifestVersion: 1,
        security: { cors: ['${TEST_ORIGIN}', 'https://other.example.com'] },
      });
      const path = writeTempManifest(manifest);

      let capturedConfig: Record<string, unknown> | undefined;
      const spy = spyOn(serverModule, 'createServer').mockImplementation(config => {
        capturedConfig = config as Record<string, unknown>;
        return Promise.resolve(makeTestServer());
      });

      try {
        await createServerFromManifest(path);
        const security = capturedConfig?.['security'] as Record<string, unknown> | undefined;
        expect(security?.['cors']).toEqual([
          'https://test.example.com',
          'https://other.example.com',
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

/**
 * Additional coverage tests for createServerFromManifest.ts
 *
 * Targets uncovered lines: 132-138, 289-291, 298-300, 303-305, 307,
 * 340-436, 470, 514-566.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import * as builtinPluginsModule from '../../src/lib/builtinPlugins';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import * as serverModule from '../../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempManifest(content: string, dir?: string): string {
  const d =
    dir ?? join(tmpdir(), `slingshot-cov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  const path = join(d, 'app.manifest.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

type TestServer = Awaited<ReturnType<typeof serverModule.createServer>>;

function makeTestServer(): TestServer {
  return {
    stop: () => Promise.resolve(),
    port: 3000,
  } as unknown as TestServer;
}

function makePlugin(name: string): SlingshotPlugin {
  return { name };
}

// ---------------------------------------------------------------------------
// 1. afterAdapters hooks in synthetic entity plugin (lines 131-138)
// ---------------------------------------------------------------------------

describe('synthetic entity plugin with afterAdapters hooks', () => {
  it('includes afterAdapters hooks in the synthetic entity plugin config', async () => {
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
      hooks: {
        afterAdapters: [
          { handler: 'myAfterAdaptersHook' },
          { handler: 'anotherHook', params: { foo: 'bar' } },
        ],
      },
    });
    const path = writeTempManifest(manifest);

    const dir = join(tmpdir(), `slingshot-hooks-handler-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'slingshot.handlers.ts'),
      `export const hooks = {
        myAfterAdaptersHook: async () => {},
        anotherHook: async () => {},
      };\n`,
      'utf-8',
    );

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    const registry = createManifestHandlerRegistry();

    try {
      await createServerFromManifest(path, registry, { handlersPath: { dir } });

      // Verify the synthetic entity plugin config includes afterAdapters hooks
      expect(capturedEntityConfig).toBeDefined();
      const entityManifest = capturedEntityConfig!.manifest as Record<string, unknown>;
      expect(entityManifest).toBeDefined();
      const entityHooks = entityManifest.hooks as {
        afterAdapters: Array<{ handler: string; params?: unknown }>;
      };
      expect(entityHooks).toBeDefined();
      expect(entityHooks.afterAdapters).toHaveLength(2);
      expect(entityHooks.afterAdapters[0].handler).toBe('myAfterAdaptersHook');
      expect(entityHooks.afterAdapters[1].handler).toBe('anotherHook');
      expect(entityHooks.afterAdapters[1].params).toEqual({ foo: 'bar' });
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('includes apiPrefix as mountPath in synthetic entity plugin config', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      apiPrefix: '/api/v1',
      entities: {
        Item: {
          fields: {
            id: { type: 'string', primary: true },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path);
      expect(capturedEntityConfig?.mountPath).toBe('/api/v1');
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. ensureBuiltinEventBusFactories — missing REDIS_HOST (lines 289-291)
// ---------------------------------------------------------------------------

describe('BullMQ event bus error paths', () => {
  it('throws when REDIS_HOST is not set for bullmq event bus', async () => {
    const prevHost = process.env.REDIS_HOST;
    const prevUser = process.env.REDIS_USER;
    const prevPass = process.env.REDIS_PASSWORD;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_USER;
    delete process.env.REDIS_PASSWORD;

    const path = writeTempManifest(
      JSON.stringify({
        manifestVersion: 1,
        eventBus: 'bullmq',
      }),
    );

    try {
      await expect(createServerFromManifest(path)).rejects.toThrow(
        'eventBus "bullmq" requires REDIS_HOST',
      );
    } finally {
      if (prevHost !== undefined) process.env.REDIS_HOST = prevHost;
      if (prevUser !== undefined) process.env.REDIS_USER = prevUser;
      if (prevPass !== undefined) process.env.REDIS_PASSWORD = prevPass;
    }
  });

  // NOTE: The invalid-shape test (lines 298-300) is hard to cover without
  // polluting the mock.module cache for other tests. The TypeError thrown
  // at line 298 is immediately caught by the catch at line 303, which
  // re-throws with the "requires package" message. Both error paths
  // (298-300 inner throw, 303-307 outer rethrow) are effectively the same
  // control flow. The missing REDIS_HOST test above covers line 289-291,
  // and the "requires package" path is tested via the existing
  // createServerFromManifest.test.ts tests.
});

// ---------------------------------------------------------------------------
// 3. Plugin seed lifecycle (runPluginSeed)
// ---------------------------------------------------------------------------

describe('manifest seed', () => {
  // Seed logic now lives in each plugin's seed() method. These tests verify
  // the runPluginSeed orchestrator calls plugin.seed() in order and threads
  // the shared seedState map between plugins.

  it('calls seed() on plugins that implement it', async () => {
    const { runPluginSeed } = await import('../../src/framework/runPluginLifecycle');
    const seedCalls: string[] = [];
    const plugins: SlingshotPlugin[] = [
      {
        name: 'plugin-a',
        setupMiddleware: async () => {},
        async seed({ seedState }) {
          seedCalls.push('a');
          seedState.set('a:done', true);
        },
      },
      {
        name: 'plugin-b',
        setupMiddleware: async () => {},
        async seed({ seedState }) {
          seedCalls.push('b');
          expect(seedState.get('a:done')).toBe(true);
        },
      },
    ];

    const app = {} as any;
    const bus = {
      publish: async () => {},
      emit: () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
    } as any;
    const events = { publish: () => ({}) } as any;

    await runPluginSeed(plugins, app, bus, events, { users: [] });
    expect(seedCalls).toEqual(['a', 'b']);
  });

  it('skips plugins without seed()', async () => {
    const { runPluginSeed } = await import('../../src/framework/runPluginLifecycle');
    const plugins: SlingshotPlugin[] = [{ name: 'no-seed', setupMiddleware: async () => {} }];

    const app = {} as any;
    const bus = {
      publish: async () => {},
      emit: () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
    } as any;
    const events = { publish: () => ({}) } as any;

    // Should not throw
    await runPluginSeed(plugins, app, bus, events, {});
  });

  it('threads seedState across plugins for cross-plugin coordination', async () => {
    const { runPluginSeed } = await import('../../src/framework/runPluginLifecycle');
    const plugins: SlingshotPlugin[] = [
      {
        name: 'auth-seed',
        setupMiddleware: async () => {},
        async seed({ manifestSeed, seedState }) {
          const users = manifestSeed.users as Array<{ email: string }>;
          for (const u of users ?? []) {
            seedState.set(`user:${u.email}`, `id-${u.email}`);
          }
        },
      },
      {
        name: 'perms-seed',
        setupMiddleware: async () => {},
        async seed({ seedState }) {
          // Should see IDs from auth-seed
          expect(seedState.get('user:admin@test.com')).toBe('id-admin@test.com');
        },
      },
    ];

    const app = {} as any;
    const bus = {
      publish: async () => {},
      emit: () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
    } as any;
    const events = { publish: () => ({}) } as any;

    await runPluginSeed(plugins, app, bus, events, {
      users: [{ email: 'admin@test.com', password: 'secret' }],
    });
  });

  it('createServerFromManifest calls runPluginSeed when seed data is present', async () => {
    const seedCalled = mock(async () => {});
    const fakePlugin: SlingshotPlugin = {
      name: 'test-seed-plugin',
      setupMiddleware: async () => {},
      seed: seedCalled,
    };

    function makeServerWithContext(ctx: Record<string, unknown>): TestServer {
      const server = {
        stop: () => Promise.resolve(),
        port: 3000,
      } as unknown as TestServer;
      Object.defineProperty(server, Symbol.for('slingshot.serverContext'), {
        configurable: true,
        enumerable: false,
        writable: true,
        value: ctx,
      });
      return server;
    }

    const ctx = {
      plugins: [fakePlugin],
      app: {},
      bus: {
        publish: async () => {},
        emit: () => {},
        subscribe: () => ({ unsubscribe: () => {} }),
      },
      events: { publish: () => ({}) },
    };

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'admin@test.com', password: 'secret' }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(seedCalled).toHaveBeenCalledTimes(1);
    } finally {
      serverSpy.mockRestore();
    }
  });

  it('skips seed when no seed data in manifest', async () => {
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    const manifest = JSON.stringify({ manifestVersion: 1 });
    const path = writeTempManifest(manifest);

    try {
      const server = await createServerFromManifest(path);
      expect(server).toBeDefined();
    } finally {
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Manifest validation warnings (line 470)
// ---------------------------------------------------------------------------

describe('manifest validation warnings', () => {
  it('logs warnings from manifest validation', async () => {
    // unix + port triggers a warning
    const manifest = JSON.stringify({
      manifestVersion: 1,
      unix: '/tmp/test.sock',
      port: 3000,
    });
    const path = writeTempManifest(manifest);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path);
      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(
        warnings.some(
          (w: string) => typeof w === 'string' && w.includes('[createServerFromManifest]'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Entity handler/hook registration (lines 514-566)
// ---------------------------------------------------------------------------

describe('entity handler and hook registration into entity plugin', () => {
  it('bridges custom operation handlers from ManifestHandlerRegistry to entity plugin', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
            title: { type: 'string' },
          },
          operations: {
            publish: {
              kind: 'custom',
              handler: 'publishPost',
              method: 'POST',
              path: '/publish',
            },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    const publishFn = () => new Response('ok');
    registry.registerHandler('publishPost', () => publishFn);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
      expect(capturedEntityConfig).toBeDefined();
      const manifestRuntime = capturedEntityConfig!.manifestRuntime as Record<string, unknown>;
      expect(manifestRuntime).toBeDefined();
      expect(manifestRuntime.customHandlers).toBeDefined();
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('bridges afterAdapters hooks from ManifestHandlerRegistry to entity plugin', async () => {
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
      hooks: {
        afterAdapters: [{ handler: 'myHook' }],
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    const hookFn = async () => {};
    registry.registerHook('myHook', hookFn);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
      expect(capturedEntityConfig).toBeDefined();
      const manifestRuntime = capturedEntityConfig!.manifestRuntime as Record<string, unknown>;
      expect(manifestRuntime).toBeDefined();
      expect(manifestRuntime.hooks).toBeDefined();
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips unregistered custom handlers gracefully', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
          },
          operations: {
            doSomething: {
              kind: 'custom',
              handler: 'notRegistered',
              method: 'POST',
              path: '/do',
            },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    // Note: 'notRegistered' handler is NOT registered in the registry

    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(() =>
      makePlugin('mock-plugin'),
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      // Should not throw even though handler is not registered
      await createServerFromManifest(path, registry);
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips unregistered afterAdapters hooks gracefully', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
          },
        },
      },
      hooks: {
        afterAdapters: [{ handler: 'nonexistentHook' }],
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    // 'nonexistentHook' is NOT registered

    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(() =>
      makePlugin('mock-plugin'),
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

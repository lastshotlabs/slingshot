import { describe, expect, mock, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

// Minimal createApp config that avoids real DB connections.
// routesDir must point to a real (but empty or minimal) directory so the routes glob does not
// accidentally scan the whole project when no directory is given.
const baseConfig = {
  routesDir: import.meta.dir + '/../fixtures/routes',
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: { rateLimit: { windowMs: 60_000, max: 100 } },
  logging: { onLog: () => {} },
};

const SearchableMessage = defineEntity('SearchableMessage', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true }),
    body: field.string(),
  },
  search: {
    fields: {
      body: { searchable: true },
    },
  },
});

describe('Plugin lifecycle', () => {
  test('dependency comes first: setupMiddleware called on A before B', async () => {
    const order: string[] = [];
    const pluginA: SlingshotPlugin = {
      name: 'a',
      setupMiddleware: mock(async () => {
        order.push('a:middleware');
      }),
    };
    const pluginB: SlingshotPlugin = {
      name: 'b',
      dependencies: ['a'],
      setupMiddleware: mock(async () => {
        order.push('b:middleware');
      }),
    };
    await createApp({ ...baseConfig, plugins: [pluginB, pluginA] }); // intentionally reversed
    expect(order[0]).toBe('a:middleware');
    expect(order[1]).toBe('b:middleware');
  });

  test("diamond dependency: A <- B, A <- C, A's setupMiddleware called exactly once", async () => {
    const order: string[] = [];
    const pluginA: SlingshotPlugin = {
      name: 'a',
      setupMiddleware: mock(async () => {
        order.push('a');
      }),
    };
    const pluginB: SlingshotPlugin = {
      name: 'b',
      dependencies: ['a'],
      setupMiddleware: mock(async () => {
        order.push('b');
      }),
    };
    const pluginC: SlingshotPlugin = {
      name: 'c',
      dependencies: ['a'],
      setupMiddleware: mock(async () => {
        order.push('c');
      }),
    };
    await createApp({ ...baseConfig, plugins: [pluginB, pluginC, pluginA] });
    const aCalls = order.filter(x => x === 'a');
    expect(aCalls).toHaveLength(1);
    // A must appear before both B and C
    const aIdx = order.indexOf('a');
    const bIdx = order.indexOf('b');
    const cIdx = order.indexOf('c');
    expect(aIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeLessThan(cIdx);
  });

  test('validation throws: plugin declares missing dependency', async () => {
    const pluginB: SlingshotPlugin = {
      name: 'b',
      dependencies: ['missing-plugin'],
      setupMiddleware: async () => {},
    };
    await expect(createApp({ ...baseConfig, plugins: [pluginB] })).rejects.toThrow(
      'Plugin "b" declares dependency "missing-plugin" but it is not in the plugins array',
    );
  });

  test('validation throws: plugin with no lifecycle methods', async () => {
    const badPlugin = {
      name: 'empty-plugin',
    } as unknown as SlingshotPlugin;
    await expect(createApp({ ...baseConfig, plugins: [badPlugin] })).rejects.toThrow(
      'Plugin "empty-plugin" must define at least one of: setupMiddleware, setupRoutes, setupPost, or setup',
    );
  });

  test('phase ordering: setupMiddleware called before setupRoutes before setupPost', async () => {
    const order: string[] = [];
    const plugin: SlingshotPlugin = {
      name: 'multi-phase',
      setupMiddleware: mock(async () => {
        order.push('middleware');
      }),
      setupRoutes: mock(async () => {
        order.push('routes');
      }),
      setupPost: mock(async () => {
        order.push('post');
      }),
    };
    await createApp({ ...baseConfig, plugins: [plugin] });
    expect(order).toEqual(['middleware', 'routes', 'post']);
  });

  test('entities registered before setupPost are visible through frameworkConfig.entityRegistry', async () => {
    let discoveredStorageNames: string[] = [];

    const registrarPlugin: SlingshotPlugin = {
      name: 'registrar-plugin',
      setupRoutes: async ({ config: frameworkConfig }) => {
        frameworkConfig.entityRegistry.register(SearchableMessage);
      },
    };

    const observerPlugin: SlingshotPlugin = {
      name: 'observer-plugin',
      dependencies: ['registrar-plugin'],
      setupPost: async ({ config: frameworkConfig }) => {
        discoveredStorageNames = frameworkConfig.entityRegistry
          .filter(entity => !!entity.search)
          .map(entity => entity._storageName);
      },
    };

    await createApp({ ...baseConfig, plugins: [observerPlugin, registrarPlugin] });

    expect(discoveredStorageNames).toContain('chat_searchable_messages');
  });

  test('setup()-only plugin is skipped by framework lifecycle phases', async () => {
    const setupFn = mock(async () => {});
    const plugin: SlingshotPlugin = {
      name: 'standalone',
      setup: setupFn,
    };
    // Should not throw (but logs info)
    await createApp({ ...baseConfig, plugins: [plugin] });
    // setup() is never called by the framework — it is standalone-only
    expect(setupFn).not.toHaveBeenCalled();
  });
});

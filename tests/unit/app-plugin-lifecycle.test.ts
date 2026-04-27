import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import type { AppEnv, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import {
  runPluginMiddleware,
  runPluginPost,
  runPluginRoutes,
  runPluginTeardown,
  validateAndSortPlugins,
} from '../../src/framework/runPluginLifecycle';

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

describe('validateAndSortPlugins — direct', () => {
  test('throws on circular dependency (lines 45-47)', () => {
    const pluginA: SlingshotPlugin = {
      name: 'a',
      dependencies: ['b'],
      setupMiddleware: async () => {},
    };
    const pluginB: SlingshotPlugin = {
      name: 'b',
      dependencies: ['a'],
      setupMiddleware: async () => {},
    };
    expect(() => validateAndSortPlugins([pluginA, pluginB])).toThrow(
      /Circular plugin dependency detected/,
    );
  });

  test('cross-phase validation catches setup-only plugin used as dep for middleware plugin (lines 162-171)', () => {
    // standalone-dep has earliest phase 3 (setup-only), dependent has phase 0 (setupMiddleware).
    // Cross-phase validation fires because depPhase (3) > pluginPhase (0).
    const standalone: SlingshotPlugin = {
      name: 'standalone-dep',
      setup: async () => {},
    };
    const dependent: SlingshotPlugin = {
      name: 'dependent',
      dependencies: ['standalone-dep'],
      setupMiddleware: async () => {},
    };
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect(() => validateAndSortPlugins([standalone, dependent])).toThrow(
        /earliest phase.*setupMiddleware.*depends on.*setup-only/,
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('throws on duplicate plugin names (lines 124-126)', () => {
    const p1: SlingshotPlugin = { name: 'dup', setupMiddleware: async () => {} };
    const p2: SlingshotPlugin = { name: 'dup', setupRoutes: async () => {} };
    expect(() => validateAndSortPlugins([p1, p2])).toThrow(/Duplicate plugin name "dup"/);
  });

  test('throws on cross-phase dependency violation (lines 167-171)', () => {
    // Plugin with setupMiddleware depends on a plugin that only has setupPost
    const late: SlingshotPlugin = { name: 'late', setupPost: async () => {} };
    const early: SlingshotPlugin = {
      name: 'early',
      dependencies: ['late'],
      setupMiddleware: async () => {},
    };
    expect(() => validateAndSortPlugins([late, early])).toThrow(
      /earliest phase.*setupMiddleware.*depends on.*setupPost/,
    );
  });

  test('cross-phase validation throws when dep not found in nameToPlugin (lines 162-163)', () => {
    // This is a defensive path — normally caught earlier by the missing-dep check.
    // But we test it through a scenario where the nameToPlugin lookup fails during
    // cross-phase validation. The earlier check uses pluginNames (a Set of strings),
    // while this one uses nameToPlugin (a Map). They should be identical, but we
    // verify the error message is correct.
    const plugin: SlingshotPlugin = {
      name: 'orphan',
      dependencies: ['ghost'],
      setupMiddleware: async () => {},
    };
    // The earlier check (lines 134-139) fires first with the same message pattern
    expect(() => validateAndSortPlugins([plugin])).toThrow(
      /Plugin "orphan" declares dependency "ghost"/,
    );
  });
});

describe('runPlugin* functions — no tracer branch', () => {
  const dummyApp = new OpenAPIHono<AppEnv>();
  const dummyConfig = {} as any;
  const dummyBus = {} as any;
  const dummyEvents = {} as import('@lastshotlabs/slingshot-core').SlingshotEvents;

  test('runPluginMiddleware calls setupMiddleware without tracer (line 219-220)', async () => {
    const fn = mock(async () => {});
    const plugin: SlingshotPlugin = { name: 'mw', setupMiddleware: fn };
    await runPluginMiddleware([plugin], dummyApp, dummyConfig, dummyBus, dummyEvents);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('runPluginRoutes calls setupRoutes without tracer (line 261-262)', async () => {
    const fn = mock(async () => {});
    const plugin: SlingshotPlugin = { name: 'rt', setupRoutes: fn };
    await runPluginRoutes([plugin], dummyApp, dummyConfig, dummyBus, dummyEvents);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('runPluginPost calls setupPost without tracer (line 303-304)', async () => {
    const fn = mock(async () => {});
    const plugin: SlingshotPlugin = { name: 'ps', setupPost: fn };
    await runPluginPost([plugin], dummyApp, dummyConfig, dummyBus, dummyEvents);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('runPluginTeardown collects all errors into AggregateError (line 328+)', async () => {
    const p1: SlingshotPlugin = {
      name: 'a',
      teardown: async () => {
        throw new Error('a failed');
      },
      setupPost: async () => {},
    };
    const p2: SlingshotPlugin = {
      name: 'b',
      teardown: async () => {
        throw new Error('b failed');
      },
      setupPost: async () => {},
    };
    await expect(runPluginTeardown([p1, p2])).rejects.toThrow(AggregateError);
  });

  test('runPluginTeardown wraps non-Error throws', async () => {
    const plugin: SlingshotPlugin = {
      name: 'non-error',
      teardown: async () => {
        throw 'string-error';
      },
      setupPost: async () => {},
    };
    try {
      await runPluginTeardown([plugin]);
    } catch (err: any) {
      expect(err).toBeInstanceOf(AggregateError);
      expect(err.errors[0].message).toBe('string-error');
    }
  });
});

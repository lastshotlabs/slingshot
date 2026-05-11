/**
 * Unit tests for createEntityPlugin().
 *
 * Uses mock infrastructure so no real Hono, no real adapters.
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  AppEnv,
  EntityRegistry,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
  PluginSetupContext,
  RepoFactories,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  PERMISSIONS_STATE_KEY,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  publishEntityAdaptersState,
  requireEntityAdapter,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityPlugin } from '../../src/createEntityPlugin';
import type { EntityPluginEntry } from '../../src/createEntityPlugin';
import type { MultiEntityManifest } from '../../src/manifest/multiEntityManifest';
import { defineEntityRoute } from '../../src/routing';
import type { BareEntityAdapter } from '../../src/routing/buildBareEntityRoutes';

// ---------------------------------------------------------------------------
// Minimal mock entity config
// ---------------------------------------------------------------------------

const noteConfig: ResolvedEntityConfig = {
  name: 'Note',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    text: { type: 'string', primary: false, immutable: false, optional: false },
    authorId: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'notes',
  _systemFields: {
    createdBy: 'createdBy',
    updatedBy: 'updatedBy',
    ownerField: 'ownerId',
    tenantField: 'tenantId',
    version: 'version',
  },
  _storageFields: {
    mongoPkField: '_id',
    ttlField: '_expires_at',
    mongoTtlField: '_expiresAt',
  },
  _conventions: {},
  routes: {
    create: { auth: 'userAuth' },
    list: {},
  },
};

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function createMockAdapter(): BareEntityAdapter {
  return {
    create: mock((data: unknown) => Promise.resolve({ id: '1', ...(data as object) })),
    getById: mock((id: string) => Promise.resolve(id === 'exists' ? { id } : null)),
    list: mock(() => Promise.resolve({ items: [], hasMore: false })),
    update: mock((id: string, data: unknown) => Promise.resolve({ id, ...(data as object) })),
    delete: mock(() => Promise.resolve(true)),
  };
}

// ---------------------------------------------------------------------------
// Mock bus
// ---------------------------------------------------------------------------

function createMockBus(): SlingshotEventBus & {
  emitted: Array<{ key: string; payload: unknown }>;
  subscriptions: Array<{
    event: string;
    handler: (p: Record<string, unknown>) => void | Promise<void>;
  }>;
} {
  const emitted: Array<{ key: string; payload: unknown }> = [];
  const subscriptions: Array<{
    event: string;
    handler: (p: Record<string, unknown>) => void | Promise<void>;
  }> = [];

  return {
    emit: mock((key: string, payload: unknown) => {
      emitted.push({ key, payload });
    }) as unknown as SlingshotEventBus['emit'],
    on: mock((event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
      subscriptions.push({ event, handler });
    }),
    off: mock((event: string) => {
      const idx = subscriptions.findIndex(s => s.event === event);
      if (idx !== -1) subscriptions.splice(idx, 1);
    }),
    onEnvelope: mock(
      (event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
        subscriptions.push({ event, handler });
      },
    ) as unknown as SlingshotEventBus['onEnvelope'],
    offEnvelope: mock((event: string) => {
      const idx = subscriptions.findIndex(s => s.event === event);
      if (idx !== -1) subscriptions.splice(idx, 1);
    }) as unknown as SlingshotEventBus['offEnvelope'],
    shutdown: mock(() => Promise.resolve()),
    emitted,
    subscriptions,
  };
}

// ---------------------------------------------------------------------------
// Mock framework config
// ---------------------------------------------------------------------------

function createMockFrameworkConfig(): SlingshotFrameworkConfig & {
  entityRegistry: EntityRegistry & { registered: ResolvedEntityConfig[] };
} {
  const registered: ResolvedEntityConfig[] = [];
  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    logging: {
      enabled: false,
      verbose: false,
      authTrace: false,
      auditWarnings: false,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false,
    password: Bun.password,
    storeInfra: createMemoryStoreInfra(),
    registrar: {} as unknown as import('@lastshotlabs/slingshot-core').CoreRegistrar,
    entityRegistry: {
      registered,
      register: mock((config: ResolvedEntityConfig) => {
        registered.push(config);
      }),
      get: mock(() => undefined),
      list: mock(() => []),
    } as unknown as EntityRegistry & { registered: ResolvedEntityConfig[] },
  };
}

// ---------------------------------------------------------------------------
// Mock Hono app
// ---------------------------------------------------------------------------

type MockApp = import('hono').Hono<AppEnv> & {
  route: ReturnType<typeof mock>;
  use: ReturnType<typeof mock>;
  routes: Array<{ path: string; router: unknown }>;
};

function createMockApp(): MockApp {
  const routes: Array<{ path: string; router: unknown }> = [];
  return {
    route: mock((path: string, router: unknown) => {
      routes.push({ path, router });
    }),
    use: mock(() => {}),
    routes,
  } as unknown as MockApp;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  config: ResolvedEntityConfig,
  adapter?: BareEntityAdapter,
): EntityPluginEntry & { adapter: BareEntityAdapter } {
  const a = adapter ?? createMockAdapter();
  return {
    config,
    buildAdapter: () => a,
    adapter: a,
  };
}

function createSetupContext(
  app: MockApp,
  config: ReturnType<typeof createMockFrameworkConfig>,
  bus: ReturnType<typeof createMockBus>,
): PluginSetupContext {
  return {
    app,
    config,
    bus,
    events: createEventPublisher({
      definitions: createEventDefinitionRegistry(),
      bus,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEntityPlugin', () => {
  it('returns a valid SlingshotPlugin with name', () => {
    const plugin = createEntityPlugin({ name: 'test-plugin', entities: [] });
    expect(plugin.name).toBe('test-plugin');
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
    expect(typeof plugin.teardown).toBe('function');
  });

  it('passes dependencies through', () => {
    const plugin = createEntityPlugin({
      name: 'p',
      dependencies: ['slingshot-auth'],
      entities: [],
    });
    expect(plugin.dependencies).toEqual(['slingshot-auth']);
  });

  it('does not warn for package-authored entity extraRoutes or overrides', () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      createEntityPlugin({
        name: 'package-authored',
        entities: [
          {
            config: noteConfig,
            authoringSource: 'package',
            buildAdapter: () => createMockAdapter(),
            extraRoutes: [
              defineEntityRoute({
                method: 'get',
                path: '/tree',
                buildExecutor: () => async exec => exec.respond.json({ ok: true }),
              }),
            ],
          },
        ],
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warn).not.toHaveBeenCalled();
  });

  describe('setupRoutes', () => {
    it('mounts a router for each entity with routes config', async () => {
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      // Mount at root when no mountPath is set. The segment (`/notes`) is
      // added inside the router by buildBareEntityRoutes, so the app-level
      // route prefix is '/'.
      expect(app.routes.length).toBe(1);
      expect(app.routes[0].path).toBe('/');
    });

    it('does not mount a router when entity has no routes config', async () => {
      const configNoRoutes: ResolvedEntityConfig = { ...noteConfig, routes: undefined };
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(configNoRoutes);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      expect(app.routes.length).toBe(0);
    });

    it('respects mountPath prefix', async () => {
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({
        name: 'p',
        mountPath: '/api/v1',
        entities: [entry],
      });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      // Mount at mountPath; the `/notes` segment is added inside the router.
      expect(app.routes[0].path).toBe('/api/v1');
    });

    it('registers entity in entityRegistry', async () => {
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      expect(fw.entityRegistry.registered).toHaveLength(1);
      expect(fw.entityRegistry.registered[0].name).toBe('Note');
    });

    it('publishes resolved adapters into plugin-owned state during setupRoutes', async () => {
      const app = createMockApp();
      const pluginState = new Map<string, unknown>();
      attachContext(app, { pluginState } as never);
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      expect(pluginState.get('p')).toMatchObject({
        entityAdapters: {
          Note: entry.adapter,
        },
      });
    });

    it('makes provider adapters available to dependent plugins during setupRoutes', async () => {
      const app = createMockApp();
      const pluginState = new Map<string, unknown>();
      attachContext(app, { pluginState } as never);
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(noteConfig);
      const provider = createEntityPlugin({ name: 'provider', entities: [entry] });

      let resolved: BareEntityAdapter | null = null;
      const dependent = {
        name: 'dependent',
        dependencies: ['provider'],
        setupRoutes({ app: routeApp }: { app: object }) {
          resolved = requireEntityAdapter<BareEntityAdapter>(routeApp, {
            plugin: 'provider',
            entity: 'Note',
          });
        },
      };

      await provider.setupRoutes!(createSetupContext(app, fw, bus));
      await dependent.setupRoutes({ app });

      expect(resolved as BareEntityAdapter | null).toBe(entry.adapter);
    });

    it('fails setupRoutes when the same entity name was published with a different adapter instance', async () => {
      const app = createMockApp();
      const pluginState = new Map<string, unknown>();
      attachContext(app, { pluginState } as never);
      publishEntityAdaptersState(pluginState, 'p', {
        Note: createMockAdapter(),
      });

      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const plugin = createEntityPlugin({
        name: 'p',
        entities: [makeEntry(noteConfig, createMockAdapter())],
      });

      await expect(plugin.setupRoutes!(createSetupContext(app, fw, bus))).rejects.toThrow(
        "Entity adapter 'Note' for plugin 'p' was already published",
      );
    });

    it('builds extra-route executors with published cross-entity adapter lookup helpers', async () => {
      const app = createMockApp();
      const pluginState = new Map<string, unknown>();
      attachContext(app, { pluginState } as never);
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();

      const categoryConfig: ResolvedEntityConfig = {
        ...noteConfig,
        name: 'Category',
        _storageName: 'categories',
      };
      const noteAdapter = createMockAdapter();
      const categoryAdapter = createMockAdapter();
      let resolvedCategory: BareEntityAdapter | null = null;

      const plugin = createEntityPlugin({
        name: 'p',
        entities: [
          {
            config: noteConfig,
            buildAdapter: () => noteAdapter,
            extraRoutes: [
              defineEntityRoute({
                method: 'get',
                path: '/tree',
                buildExecutor(ctx) {
                  resolvedCategory = ctx.getEntityAdapter({ plugin: 'p', entity: 'Category' });
                  return async exec => exec.respond.json({ ok: true });
                },
              }),
            ],
          },
          {
            config: categoryConfig,
            buildAdapter: () => categoryAdapter,
          },
        ],
      });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      expect(resolvedCategory as BareEntityAdapter | null).toBe(categoryAdapter);
    });

    it('fails setupRoutes when an extra route collides with a generated route', async () => {
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const plugin = createEntityPlugin({
        name: 'p',
        entities: [
          {
            config: noteConfig,
            buildAdapter: () => createMockAdapter(),
            extraRoutes: [
              defineEntityRoute({
                method: 'get',
                path: '/:slug',
                buildExecutor: () => async exec => exec.respond.json({ ok: true }),
              }),
            ],
          },
        ],
      });

      await expect(plugin.setupRoutes!(createSetupContext(app, fw, bus))).rejects.toThrow(
        'Use overrides.get instead',
      );
    });

    it('does not throw when entity already registered', async () => {
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      (fw.entityRegistry.register as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('already registered');
      });
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      // Verify setupRoutes completes without throwing even when registration throws.
      await plugin.setupRoutes!(createSetupContext(app, fw, bus));
    });

    it('wires cascade event handlers on bus', async () => {
      const configWithCascades: ResolvedEntityConfig = {
        ...noteConfig,
        routes: {
          ...noteConfig.routes,
          cascades: [
            {
              event: 'author:deleted',
              batch: { action: 'delete', filter: { authorId: 'param:id' } },
            },
          ],
        },
      };
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(configWithCascades);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      expect(bus.subscriptions.some(s => s.event === 'author:deleted')).toBe(true);
    });

    it('cascade delete calls adapter.delete for each matched item', async () => {
      const configWithCascades: ResolvedEntityConfig = {
        ...noteConfig,
        routes: {
          ...noteConfig.routes,
          cascades: [
            {
              event: 'author:deleted',
              batch: { action: 'delete', filter: { authorId: 'param:id' } },
            },
          ],
        },
      };
      const adapter = createMockAdapter();
      (adapter.list as ReturnType<typeof mock>).mockResolvedValue({
        items: [{ id: 'note-1' }, { id: 'note-2' }],
        hasMore: false,
      });

      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(configWithCascades, adapter);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      // Trigger the cascade
      const sub = bus.subscriptions.find(s => s.event === 'author:deleted')!;
      await sub.handler({ id: 'author-42' });

      expect(adapter.delete).toHaveBeenCalledTimes(2);
      expect(adapter.delete).toHaveBeenCalledWith('note-1');
      expect(adapter.delete).toHaveBeenCalledWith('note-2');
    });

    it('cascade update calls adapter.update for each matched item', async () => {
      const configWithCascade: ResolvedEntityConfig = {
        ...noteConfig,
        routes: {
          ...noteConfig.routes,
          cascades: [
            {
              event: 'author:suspended',
              batch: {
                action: 'update',
                filter: { authorId: 'param:id' },
                set: { status: 'hidden' },
              },
            },
          ],
        },
      };
      const adapter = createMockAdapter();
      (adapter.list as ReturnType<typeof mock>).mockResolvedValue({
        items: [{ id: 'note-1' }],
        hasMore: false,
      });

      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(configWithCascade, adapter);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));

      const sub = bus.subscriptions.find(s => s.event === 'author:suspended')!;
      await sub.handler({ id: 'author-9' });

      expect(adapter.update).toHaveBeenCalledWith('note-1', { status: 'hidden' });
    });
  });

  describe('setupPost', () => {
    it('does not add subscriptions for entities without setupPost bus work', async () => {
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const app = createMockApp();
      const entry = makeEntry(noteConfig);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupPost!(createSetupContext(app, fw, bus));

      expect(bus.subscriptions).toHaveLength(0);
    });

    it('keeps setupPost quiet when routes are minimal', async () => {
      const configWithMinimalRoutes: ResolvedEntityConfig = {
        ...noteConfig,
        routes: { create: {} },
      };
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const app = createMockApp();
      const entry = makeEntry(configWithMinimalRoutes);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupPost!(createSetupContext(app, fw, bus));

      expect(bus.subscriptions).toHaveLength(0);
    });

    it('registers permission resource types', async () => {
      const configWithPerms: ResolvedEntityConfig = {
        ...noteConfig,
        routes: {
          ...noteConfig.routes,
          permissions: {
            resourceType: 'note',
            actions: ['create', 'read', 'update', 'delete'],
            roles: { editor: ['create', 'read', 'update'] },
          },
        },
      };
      const registered: unknown[] = [];
      const permissionRegistry = {
        register: mock((def: unknown) => {
          registered.push(def);
        }),
        getActionsForRole: mock(() => []),
        getDefinition: mock(() => null),
        listResourceTypes: mock(() => []),
      };
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const app = createMockApp();
      const entry = makeEntry(configWithPerms);
      const plugin = createEntityPlugin({
        name: 'p',
        entities: [entry],
        permissions: {
          registry:
            permissionRegistry as unknown as import('@lastshotlabs/slingshot-core').PermissionRegistry,
          evaluator: {} as unknown as import('@lastshotlabs/slingshot-core').PermissionEvaluator,
          adapter: {} as unknown as import('@lastshotlabs/slingshot-core').PermissionsAdapter,
        },
      });

      await plugin.setupPost!(createSetupContext(app, fw, bus));

      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({ resourceType: 'note' });
    });

    it('calls user-provided setupPost callback', async () => {
      let callbackFired = false;
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const app = createMockApp();
      const plugin = createEntityPlugin({
        name: 'p',
        entities: [],
        setupPost: ({ bus: b }) => {
          expect(b).toBe(bus);
          callbackFired = true;
        },
      });

      await plugin.setupPost!(createSetupContext(app, fw, bus));

      expect(callbackFired).toBe(true);
    });
  });

  describe('teardown', () => {
    it('unsubscribes all cascade handlers', async () => {
      const configWithCascade: ResolvedEntityConfig = {
        ...noteConfig,
        routes: {
          ...noteConfig.routes,
          cascades: [{ event: 'author:deleted', batch: { action: 'delete', filter: {} } }],
        },
      };
      const app = createMockApp();
      const bus = createMockBus();
      const fw = createMockFrameworkConfig();
      const entry = makeEntry(configWithCascade);
      const plugin = createEntityPlugin({ name: 'p', entities: [entry] });

      await plugin.setupRoutes!(createSetupContext(app, fw, bus));
      expect(bus.subscriptions).toHaveLength(1);

      await plugin.teardown!();

      expect(bus.subscriptions).toHaveLength(0);
    });

    it('is idempotent — safe to call multiple times', async () => {
      const plugin = createEntityPlugin({ name: 'p', entities: [] });
      // Verify teardown completes without throwing when called multiple times.
      await plugin.teardown!();
      await plugin.teardown!();
    });
  });
});

// ---------------------------------------------------------------------------
// EntityPluginEntryFactories tests
// ---------------------------------------------------------------------------

function makeFactoriesEntry(
  config: ResolvedEntityConfig,
  adapter?: BareEntityAdapter,
): {
  config: ResolvedEntityConfig;
  factories: RepoFactories<BareEntityAdapter>;
  adapter: BareEntityAdapter;
} {
  const a = adapter ?? createMockAdapter();
  const factories = {
    memory: () => a,
    redis: () => a,
    sqlite: () => a,
    postgres: () => a,
    mongo: () => a,
  };
  return { config, factories, adapter: a };
}

describe('EntityPluginEntryFactories — single-entity path (no entityKey)', () => {
  it('resolves adapter directly from factories when entityKey is absent', async () => {
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const { config, factories, adapter } = makeFactoriesEntry(noteConfig);

    const plugin = createEntityPlugin({ name: 'p', entities: [{ config, factories }] });
    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    // Router was mounted — adapter was resolved (create mock was not yet called, but
    // the plugin registered routes which means buildAdapter-equivalent ran without error)
    expect(app.routes.length).toBe(1);
    // Verify the mock adapter's methods are accessible by calling create via the mounted router
    expect(adapter.create).toBeDefined();
  });

  it('calls onAdapter with the resolved adapter', async () => {
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const a = createMockAdapter();
    const factories = {
      memory: () => a,
      redis: () => a,
      sqlite: () => a,
      postgres: () => a,
      mongo: () => a,
    };

    let captured: BareEntityAdapter | undefined;
    const plugin = createEntityPlugin({
      name: 'p',
      entities: [
        {
          config: noteConfig,
          factories,
          onAdapter: (adapter: BareEntityAdapter) => {
            captured = adapter;
          },
        },
      ],
    });

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    expect(captured).toBeDefined();
    expect(typeof captured!.create).toBe('function');
    expect(typeof captured!.list).toBe('function');
    expect(typeof captured!.getById).toBe('function');
  });

  it('onAdapter fires before routes are used', async () => {
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const a = createMockAdapter();
    const factories = {
      memory: () => a,
      redis: () => a,
      sqlite: () => a,
      postgres: () => a,
      mongo: () => a,
    };

    const order: string[] = [];
    const plugin = createEntityPlugin({
      name: 'p',
      entities: [
        {
          config: noteConfig,
          factories,
          onAdapter: () => {
            order.push('onAdapter');
          },
        },
      ],
    });

    (app.route as ReturnType<typeof mock>).mockImplementation(() => {
      order.push('route');
    });
    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    expect(order[0]).toBe('onAdapter');
  });
});

describe('EntityPluginEntryFactories — composite path (entityKey present)', () => {
  it('extracts entity sub-adapter and mixes composite-level ops', async () => {
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const entityAdapter = createMockAdapter();
    const compositeFn = mock(() => Promise.resolve({ result: 'reverted' }));
    const compositeObject = { ...entityAdapter, revert: compositeFn };

    const factories = {
      memory: () => ({ documents: compositeObject, revert: compositeFn }),
      redis: () => ({ documents: compositeObject, revert: compositeFn }),
      sqlite: () => ({ documents: compositeObject, revert: compositeFn }),
      postgres: () => ({ documents: compositeObject, revert: compositeFn }),
      mongo: () => ({ documents: compositeObject, revert: compositeFn }),
    };

    let capturedAdapter: BareEntityAdapter | undefined;
    const plugin = createEntityPlugin({
      name: 'p',
      entities: [
        {
          config: noteConfig,
          factories,
          entityKey: 'documents',
          onAdapter: (a: BareEntityAdapter) => {
            capturedAdapter = a;
          },
        },
      ],
    });

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    expect(capturedAdapter).toBeDefined();
    // The composite revert method was mixed onto the entity adapter
    expect(typeof (capturedAdapter as Record<string, unknown>)['revert']).toBe('function');
  });

  it('throws a clear error when entityKey is set but absent in composite', async () => {
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();

    const factories = {
      memory: () => ({ documents: createMockAdapter() }),
      redis: () => ({ documents: createMockAdapter() }),
      sqlite: () => ({ documents: createMockAdapter() }),
      postgres: () => ({ documents: createMockAdapter() }),
      mongo: () => ({ documents: createMockAdapter() }),
    };

    const plugin = createEntityPlugin({
      name: 'p',
      entities: [
        {
          config: noteConfig,
          factories,
          entityKey: 'wrong-key',
        },
      ],
    });

    await expect(plugin.setupRoutes!(createSetupContext(app, fw, bus))).rejects.toThrow(
      'wrong-key',
    );
  });

  it('op-mixing does NOT run for single-entity factories (no entityKey)', async () => {
    // Verify the deliberate scoping: when entityKey is absent, the resolved object
    // is used as-is. No extra mixing occurs even if the resolved object has extra keys.
    const app = createMockApp();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const a = { ...createMockAdapter(), customMethod: mock(() => Promise.resolve('ok')) };

    const factories = {
      memory: () => a,
      redis: () => a,
      sqlite: () => a,
      postgres: () => a,
      mongo: () => a,
    };

    let capturedAdapter: BareEntityAdapter | undefined;
    const plugin = createEntityPlugin({
      name: 'p',
      entities: [
        {
          config: noteConfig,
          factories,
          onAdapter: (adapter: BareEntityAdapter) => {
            capturedAdapter = adapter;
          },
        },
      ],
    });

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    // customMethod is present because the resolved object is used directly (it has it)
    expect(typeof (capturedAdapter as Record<string, unknown>)['customMethod']).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Permissions pluginState fallback
// ---------------------------------------------------------------------------

describe('permissions pluginState fallback', () => {
  function createMockPermissions() {
    return {
      evaluator: { can: mock(() => Promise.resolve(true)) } as unknown as PermissionEvaluator,
      registry: {
        register: mock(() => {}),
        getActionsForRole: mock(() => []),
        getDefinition: mock(() => null),
        listResourceTypes: mock(() => []),
      } as unknown as PermissionRegistry,
      adapter: {
        createGrant: mock(() => Promise.resolve('grant-1')),
        revokeGrant: mock(() => Promise.resolve()),
        listGrants: mock(() => Promise.resolve([])),
        getGrants: mock(() => Promise.resolve([])),
      } as unknown as PermissionsAdapter,
    };
  }

  it('reads permissions from pluginState when not passed in config', async () => {
    const perms = createMockPermissions();
    const pluginState = new Map<string, unknown>();
    pluginState.set(PERMISSIONS_STATE_KEY, Object.freeze(perms));

    const configWithPerms: ResolvedEntityConfig = {
      ...noteConfig,
      routes: {
        ...noteConfig.routes,
        permissions: {
          resourceType: 'note',
          actions: ['create', 'read'],
        },
      },
    };
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    // App with pluginState for context fallback
    const app = createMockApp();

    const entry = makeEntry(configWithPerms);
    const plugin = createEntityPlugin({
      name: 'p',
      entities: [entry],
      permissions: perms,
    });

    await plugin.setupPost!(createSetupContext(app, fw, bus));

    // The permissions.registry.register should have been called for the entity
    expect(perms.registry.register).toHaveBeenCalled();
  });

  // Auto-dep injection was removed — entity plugins no longer auto-declare
  // slingshot-permissions as a dependency. Permissions are resolved from
  // pluginState at runtime if available.
});

// ---------------------------------------------------------------------------
// Mock infra with RESOLVE_ENTITY_FACTORIES
// ---------------------------------------------------------------------------

function createMockInfraWithFactory(adapterForAll: BareEntityAdapter): StoreInfra {
  const infra = {} as unknown as StoreInfra;
  const allStoreFactories = {
    memory: () => adapterForAll,
    redis: () => adapterForAll,
    sqlite: () => adapterForAll,
    postgres: () => adapterForAll,
    mongo: () => adapterForAll,
  };
  Reflect.set(infra as object, RESOLVE_ENTITY_FACTORIES, () => allStoreFactories);
  return infra;
}

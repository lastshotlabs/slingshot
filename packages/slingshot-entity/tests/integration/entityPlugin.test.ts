/**
 * Integration: full createEntityPlugin lifecycle with in-memory adapter.
 *
 * CRUD routes work, events fire, cascades run.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Context, Next } from 'hono';
import type {
  AppEnv,
  EntityRegistry,
  ResolvedEntityConfig,
  SlingshotContext,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityPlugin } from '../../src/createEntityPlugin';
import { multiEntityManifestSchema } from '../../src/manifest/multiEntityManifest';
import type { MultiEntityManifest } from '../../src/manifest/multiEntityManifest';
import type { BareEntityAdapter } from '../../src/routing/buildBareEntityRoutes';

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

function createMemoryAdapter(): BareEntityAdapter {
  const records = new Map<string, Record<string, unknown>>();
  let seq = 0;

  function matchesFilter(
    record: Record<string, unknown>,
    filter?: Record<string, unknown>,
  ): boolean {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (record[key] !== value) return false;
    }
    return true;
  }

  return {
    create(data: unknown) {
      const id = String(++seq);
      const record = { id, ...(data as Record<string, unknown>) };
      records.set(id, record);
      return Promise.resolve(record);
    },
    getById(id: string, filter?: Record<string, unknown>) {
      const record = records.get(id) ?? null;
      if (!record || !matchesFilter(record, filter)) return Promise.resolve(null);
      return Promise.resolve(record);
    },
    list(opts: { filter?: unknown; limit?: number }) {
      let items = [...records.values()];

      // Minimal filter support for cascade tests
      if (opts.filter && typeof opts.filter === 'object') {
        items = items.filter(r => matchesFilter(r, opts.filter as Record<string, unknown>));
      }

      const limit = opts.limit ?? items.length;
      return Promise.resolve({ items: items.slice(0, limit), hasMore: items.length > limit });
    },
    update(id: string, data: unknown, filter?: Record<string, unknown>) {
      const existing = records.get(id);
      if (!existing || !matchesFilter(existing, filter)) return Promise.resolve(null);
      const updated = { ...existing, ...(data as Record<string, unknown>) };
      records.set(id, updated);
      return Promise.resolve(updated);
    },
    delete(id: string, filter?: Record<string, unknown>) {
      const existing = records.get(id);
      if (!existing || !matchesFilter(existing, filter)) return Promise.resolve(false);
      records.delete(id);
      return Promise.resolve(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noteEntity: ResolvedEntityConfig = {
  name: 'Note',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    text: { type: 'string', primary: false, immutable: false, optional: false },
    authorId: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'notes',
  routes: {
    create: { event: 'note:created' },
    list: {},
    clientSafeEvents: ['note:created'],
  },
};

const commentEntity: ResolvedEntityConfig = {
  name: 'Comment',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    body: { type: 'string', primary: false, immutable: false, optional: false },
    noteId: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'comments',
  routes: {
    create: {},
    list: {},
    cascades: [
      {
        event: 'note:deleted',
        batch: { action: 'delete', filter: { noteId: 'param:id' } },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Mock framework
// ---------------------------------------------------------------------------

function createFramework() {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const fw: SlingshotFrameworkConfig & {
    entityRegistry: EntityRegistry & { list(): ResolvedEntityConfig[] };
  } = {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
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
      register: mock((c: ResolvedEntityConfig) => {
        registeredEntities.push(c);
      }),
      get: mock(() => undefined),
      list: mock(() => registeredEntities),
    } as unknown as EntityRegistry & { list(): ResolvedEntityConfig[] },
  };
  return fw;
}

// ---------------------------------------------------------------------------
// Mock bus
// ---------------------------------------------------------------------------

function createBus(): SlingshotEventBus & {
  emitted: Array<{ key: string; payload: unknown }>;
  registeredClientSafe: string[][];
  subscriptions: Array<{
    event: string;
    handler: (p: Record<string, unknown>) => void | Promise<void>;
  }>;
} {
  const emitted: Array<{ key: string; payload: unknown }> = [];
  const registeredClientSafe: string[][] = [];
  const subscriptions: Array<{
    event: string;
    handler: (p: Record<string, unknown>) => void | Promise<void>;
  }> = [];

  return {
    clientSafeKeys: new Set(),
    registerClientSafeEvents: mock((keys: string[]) => {
      registeredClientSafe.push([...keys]);
    }),
    ensureClientSafeEventKey: mock((k: string) => k),
    emit: mock((key: string, payload: unknown) => {
      emitted.push({ key, payload });
    }) as unknown as SlingshotEventBus['emit'],
    on: mock((event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
      subscriptions.push({ event, handler });
    }),
    off: mock((event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
      const idx = subscriptions.findIndex(s => s.event === event && s.handler === handler);
      if (idx !== -1) subscriptions.splice(idx, 1);
    }),
    emitted,
    registeredClientSafe,
    subscriptions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type MockApp = import('hono').Hono<AppEnv> & {
  route: ReturnType<typeof mock>;
  use: ReturnType<typeof mock>;
  routes: unknown[];
};

describe('createEntityPlugin E2E', () => {
  let noteAdapter: BareEntityAdapter;
  let commentAdapter: BareEntityAdapter;
  let bus: ReturnType<typeof createBus>;
  let fw: ReturnType<typeof createFramework>;
  let app: MockApp;

  beforeEach(() => {
    noteAdapter = createMemoryAdapter();
    commentAdapter = createMemoryAdapter();
    bus = createBus();
    fw = createFramework();
    const routes: unknown[] = [];
    app = {
      route: mock((path: string, router: unknown) => routes.push({ path, router })),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;
  });

  it('mounts routers for both entities', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => noteAdapter,
        },
        {
          config: commentEntity,
          buildAdapter: () => commentAdapter,
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    // Both entity routers are mounted at the same app-level path (root '/')
    // because buildBareEntityRoutes adds the entity segment (`/notes`,
    // `/comments`) inside each router, not as an app.route prefix.
    expect(app.routes).toHaveLength(2);
    const paths = (app.routes as Array<{ path: string }>).map(r => r.path);
    expect(paths.every(p => p === '/')).toBe(true);
  });

  it('CRUD routes respond correctly', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => noteAdapter,
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    // Single entity, mounted at '/'. The router internally prefixes routes
    // with `/notes` via buildBareEntityRoutes.
    const mounted = (app.routes as Array<{ path: string; router: import('hono').Hono }>)[0];
    const router = mounted.router;

    // Create
    const createReq = new Request('http://localhost/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', authorId: 'user-1' }),
    });
    const createRes = await (router as { fetch(r: Request): Promise<Response> }).fetch(createReq);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.text).toBe('hello');
    expect(created.id).toBeDefined();

    // List
    const listReq = new Request('http://localhost/notes');
    const listRes = await (router as { fetch(r: Request): Promise<Response> }).fetch(listReq);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  it('registers entities in entityRegistry', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => noteAdapter,
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    expect((fw.entityRegistry.list as ReturnType<typeof mock>)()).toHaveLength(1);
  });

  it('cascades delete comments when note:deleted fires', async () => {
    // Seed comments for note "10"
    await commentAdapter.create({ body: 'c1', noteId: '10' });
    await commentAdapter.create({ body: 'c2', noteId: '10' });
    await commentAdapter.create({ body: 'c3', noteId: '99' }); // different note

    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: commentEntity,
          buildAdapter: () => commentAdapter,
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    // Fire the cascade event
    const sub = bus.subscriptions.find(s => s.event === 'note:deleted')!;
    expect(sub).toBeDefined();
    await sub.handler({ id: '10' });

    const { items } = await commentAdapter.list({});
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).noteId).toBe('99');
  });

  it('setupPost registers clientSafeEvents', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => noteAdapter,
        },
      ],
    });

    await plugin.setupPost!({ app, config: fw, bus });

    expect(bus.registeredClientSafe.flat()).toContain('note:created');
  });

  it('teardown removes cascade subscriptions', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: commentEntity,
          buildAdapter: () => commentAdapter,
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });
    expect(bus.subscriptions).toHaveLength(1);

    await plugin.teardown!();
    expect(bus.subscriptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EntityPluginEntryFactories — integration
// ---------------------------------------------------------------------------

describe('factories entry — single-entity HTTP round-trip', () => {
  it('POST /notes creates a record when wired via factories (no entityKey)', async () => {
    const adapter = createMemoryAdapter();
    const factories = {
      memory: () => adapter,
      redis: () => adapter,
      sqlite: () => adapter,
      postgres: () => adapter,
      mongo: () => adapter,
    };

    const fw = createFramework();
    const bus = createBus();
    const routes: unknown[] = [];
    const app = {
      route: mock((path: string, router: unknown) => routes.push({ path, router })),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;

    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [{ config: noteEntity, factories: factories as never }],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    const mounted = (
      routes as Array<{ path: string; router: { fetch(r: Request): Promise<Response> } }>
    )[0];
    const createRes = await mounted.router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', authorId: 'user-1' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.text).toBe('hello');
    expect(created.id).toBeDefined();
  });
});

describe('factories entry — onAdapter ref capture', () => {
  it('onAdapter ref is usable after setupRoutes completes', async () => {
    const underlyingAdapter = createMemoryAdapter();
    const factories = {
      memory: () => underlyingAdapter,
      redis: () => underlyingAdapter,
      sqlite: () => underlyingAdapter,
      postgres: () => underlyingAdapter,
      mongo: () => underlyingAdapter,
    };

    let adapterRef: BareEntityAdapter | undefined;
    const fw = createFramework();
    const bus = createBus();
    const app = {
      route: mock(() => {}),
      use: mock(() => {}),
      routes: [],
    } as unknown as MockApp;

    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          factories: factories as never,
          onAdapter: (a: BareEntityAdapter) => {
            adapterRef = a;
          },
        },
      ],
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    expect(adapterRef).toBeDefined();
    const record = await adapterRef!.create({ text: 'via ref', authorId: 'user-1' });
    expect((record as Record<string, unknown>).text).toBe('via ref');
    expect((record as Record<string, unknown>).id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Manifest intake helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock StoreInfra with RESOLVE_ENTITY_FACTORIES injected.
 * The injected factory creator returns the provided adapter for every entity
 * and store type — suitable for unit/integration tests where we want to verify
 * wiring, not backend behaviour.
 */
function createMockInfraWithFactory(adapterForAll: BareEntityAdapter): StoreInfra {
  const infra = {} as unknown as StoreInfra;
  const allStoreFactories = {
    memory: () => adapterForAll,
    redis: () => adapterForAll,
    sqlite: () => adapterForAll,
    postgres: () => adapterForAll,
    mongo: () => adapterForAll,
  };
  // Inject the factory creator: returns the same fake factories regardless of config.
  Reflect.set(infra as object, RESOLVE_ENTITY_FACTORIES, () => allStoreFactories);
  return infra;
}

// ---------------------------------------------------------------------------
// Manifest intake tests
// ---------------------------------------------------------------------------

const minimalManifest: MultiEntityManifest = {
  manifestVersion: 1,
  entities: {
    Note: {
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        text: { type: 'string' },
        authorId: { type: 'string' },
      },
      routes: { create: {}, list: {} },
    },
  },
};

describe('createEntityPlugin — manifest intake', () => {
  it('throws when neither manifest nor entities are provided', () => {
    expect(() => createEntityPlugin({ name: 'x' } as unknown as never)).toThrow(
      "'entities' or 'manifest' is required",
    );
  });

  it('throws when both manifest and entities are provided', () => {
    expect(() =>
      createEntityPlugin({
        name: 'x',
        manifest: minimalManifest,
        entities: [
          {
            config: noteEntity,
            buildAdapter: () => createMemoryAdapter(),
          },
        ],
      } as unknown as never),
    ).toThrow('mutually exclusive');
  });

  it('mounts routes for entities declared in manifest', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();
    const infra = createMockInfraWithFactory(adapter);
    // Patch fw so setupRoutes receives our mock infra.
    fw.storeInfra = infra;

    const bus = createBus();
    const routes: unknown[] = [];
    const app = {
      route: mock((path: string, router: unknown) => routes.push({ path, router })),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;

    const plugin = createEntityPlugin({ name: 'notes-plugin', manifest: minimalManifest });
    await plugin.setupRoutes!({ app, config: fw, bus });

    expect(routes).toHaveLength(1);

    const mounted = (
      routes as Array<{ path: string; router: { fetch(r: Request): Promise<Response> } }>
    )[0];
    const createRes = await mounted.router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', authorId: 'user-1' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.text).toBe('hello');
  });

  it('ctx.adapters is populated in setupPost', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();
    const infra = createMockInfraWithFactory(adapter);
    fw.storeInfra = infra;

    const bus = createBus();
    const app = {
      route: mock(() => {}),
      use: mock(() => {}),
      routes: [],
    } as unknown as MockApp;

    let capturedAdapters: Record<string, BareEntityAdapter> | undefined;
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      manifest: minimalManifest,
      setupPost: ctx => {
        capturedAdapters = ctx.adapters;
      },
    });

    await plugin.setupRoutes!({ app, config: fw, bus });
    await plugin.setupPost!({ app, config: fw, bus });

    expect(capturedAdapters).toBeDefined();
    expect(capturedAdapters!['Note']).toBeDefined();
    expect(typeof capturedAdapters!['Note'].create).toBe('function');
  });

  it('entities path still works after manifest path is added (no regression)', async () => {
    const adapter = createMemoryAdapter();
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => adapter,
        },
      ],
    });

    const fw = createFramework();
    const bus = createBus();
    const routes: unknown[] = [];
    const app = {
      route: mock((path: string, router: unknown) => routes.push({ path, router })),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;

    await plugin.setupRoutes!({ app, config: fw, bus });
    expect(routes).toHaveLength(1);
  });

  it('manifest routes honor dataScope bindings end-to-end', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();
    const infra = createMockInfraWithFactory(adapter);
    fw.storeInfra = infra;

    const bus = createBus();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const app = new OpenAPIHono<AppEnv>();
    app.use('*', async (c, next) => {
      const setContext = c as unknown as { set: (key: string, value: unknown) => void };
      setContext.set('authUserId', c.req.header('x-auth-user-id') ?? 'user-a');
      setContext.set('slingshotCtx', {
        tenantId: 'tenant-1',
        pluginState: new Map<string, unknown>(),
        routeAuth: {
          userAuth: async (_ctx: Context, nextAuth: Next) => nextAuth(),
          requireRole: () => async (_ctx: Context, nextAuth: Next) => nextAuth(),
        },
      } as unknown as SlingshotContext);
      await next();
    });

    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      manifest: {
        manifestVersion: 1,
        entities: {
          Note: {
            fields: {
              id: { type: 'string', primary: true, default: 'uuid' },
              text: { type: 'string' },
              userId: { type: 'string' },
            },
            routes: {
              defaults: { auth: 'userAuth' },
              create: { auth: 'userAuth' },
              get: { auth: 'userAuth' },
              dataScope: { field: 'userId', from: 'ctx:authUserId' },
            },
          },
        },
      } as unknown as MultiEntityManifest,
    });

    await plugin.setupRoutes!({ app, config: fw, bus });

    const createRes = await app.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-user-id': 'user-a' },
        body: JSON.stringify({ text: 'scoped note', userId: 'spoofed' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.userId).toBe('user-a');

    const allowed = await app.fetch(
      new Request(`http://localhost/notes/${created.id as string}`, {
        headers: { 'x-auth-user-id': 'user-a' },
      }),
    );
    expect(allowed.status).toBe(200);

    const blocked = await app.fetch(
      new Request(`http://localhost/notes/${created.id as string}`, {
        headers: { 'x-auth-user-id': 'user-b' },
      }),
    );
    expect(blocked.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Manifest intake — comprehensive coverage
// ---------------------------------------------------------------------------

describe('createEntityPlugin — manifest intake: multiple entities', () => {
  it('mounts routes for each entity declared in manifest', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();
    const infra = createMockInfraWithFactory(adapter);
    fw.storeInfra = infra;

    const bus = createBus();
    const routes: unknown[] = [];
    const app = {
      route: mock((path: string, router: unknown) => routes.push({ path, router })),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;

    const multiManifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
        Comment: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            body: { type: 'string' },
            noteId: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
      },
    };

    const plugin = createEntityPlugin({ name: 'p', manifest: multiManifest });
    await plugin.setupRoutes!({ app, config: fw, bus });

    // Two entities → two route mounts
    expect(routes).toHaveLength(2);
  });

  it('ctx.adapters contains all manifest entities after setupRoutes + setupPost', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();
    const infra = createMockInfraWithFactory(adapter);
    fw.storeInfra = infra;

    const bus = createBus();
    const app = {
      route: mock(() => {}),
      use: mock(() => {}),
      routes: [],
    } as unknown as MockApp;

    let captured: Record<string, BareEntityAdapter> | undefined;
    const multiManifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Note: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            text: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
        Comment: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            body: { type: 'string' },
            noteId: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
      },
    };

    const plugin = createEntityPlugin({
      name: 'p',
      manifest: multiManifest,
      setupPost: ctx => {
        captured = ctx.adapters;
      },
    });

    await plugin.setupRoutes!({ app, config: fw, bus });
    await plugin.setupPost!({ app, config: fw, bus });

    expect(captured).toBeDefined();
    expect(captured!['Note']).toBeDefined();
    expect(captured!['Comment']).toBeDefined();
    expect(typeof captured!['Note'].create).toBe('function');
    expect(typeof captured!['Comment'].create).toBe('function');
  });
});

describe('createEntityPlugin — manifest intake: composites', () => {
  it('mounts composite entity via entityKey instead of both independently', async () => {
    const adapter = createMemoryAdapter();
    const fw = createFramework();

    // Composite factory returns { documents: adapter, snapshots: adapter }
    const compositeResult = { documents: adapter, snapshots: adapter };
    const infra = {} as unknown as StoreInfra;
    const compositeFactories = {
      memory: () => compositeResult,
      redis: () => compositeResult,
      sqlite: () => compositeResult,
      postgres: () => compositeResult,
      mongo: () => compositeResult,
    };
    Reflect.set(infra as object, RESOLVE_ENTITY_FACTORIES, () => compositeFactories);
    // Also wire RESOLVE_COMPOSITE_FACTORIES
    Reflect.set(infra as object, RESOLVE_COMPOSITE_FACTORIES, () => compositeFactories);
    fw.storeInfra = infra;

    const bus = createBus();
    const routes: unknown[] = [];
    const app = {
      route: mock((_path: string, router: unknown) => routes.push(router)),
      use: mock(() => {}),
      routes,
    } as unknown as MockApp;

    const compositeManifest: MultiEntityManifest = {
      manifestVersion: 1,
      entities: {
        Document: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            title: { type: 'string' },
          },
          routes: { create: {}, list: {}, update: {}, delete: {} },
        },
        Snapshot: {
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            docId: { type: 'string' },
          },
          routes: { create: {}, list: {} },
        },
      },
      composites: {
        docSnapshot: {
          entities: ['Document', 'Snapshot'],
          entityKey: 'Document',
        },
      },
    };

    const plugin = createEntityPlugin({ name: 'p', manifest: compositeManifest });
    await plugin.setupRoutes!({ app, config: fw, bus });

    // Composite replaces both individual entities → only one route mount (the primary)
    expect(routes).toHaveLength(1);
  });

  it('validates composites references unknown entity', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Document: {
          fields: { id: { type: 'string', primary: true, default: 'uuid' } },
        },
      },
      composites: {
        bad: {
          entities: ['Document', 'NonExistent'],
          entityKey: 'Document',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates composites entityKey must be in entities list', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Document: { fields: { id: { type: 'string', primary: true, default: 'uuid' } } },
        Snapshot: { fields: { id: { type: 'string', primary: true, default: 'uuid' } } },
      },
      composites: {
        docSnap: {
          entities: ['Document', 'Snapshot'],
          entityKey: 'WrongKey',
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('createEntityPlugin — manifest intake: custom op http field', () => {
  it('manifest custom op with http field passes validation', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Note: {
          fields: { id: { type: 'string', primary: true, default: 'uuid' } },
          operations: {
            publish: {
              kind: 'custom',
              http: { method: 'post', path: '/:id/publish' },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('manifest custom op with handler field passes validation', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Note: {
          fields: { id: { type: 'string', primary: true, default: 'uuid' } },
          operations: {
            publish: {
              kind: 'custom',
              handler: 'publishNoteHandler',
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('manifest custom op with neither handler nor http fails validation', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Note: {
          fields: { id: { type: 'string', primary: true, default: 'uuid' } },
          operations: {
            publish: { kind: 'custom' },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('manifest custom op with both handler and http is valid', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      entities: {
        Note: {
          fields: { id: { type: 'string', primary: true, default: 'uuid' } },
          operations: {
            publish: {
              kind: 'custom',
              handler: 'publishHandler',
              http: { method: 'post' },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

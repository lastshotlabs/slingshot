/**
 * Integration: full createEntityPlugin lifecycle with in-memory adapter.
 *
 * CRUD routes work, events fire, cascades run.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  AppEnv,
  EntityRegistry,
  PluginSetupContext,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityPlugin } from '../../src/createEntityPlugin';
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
    create: { event: 'note:created' },
    list: {},
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
    off: mock((event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
      const idx = subscriptions.findIndex(s => s.event === event && s.handler === handler);
      if (idx !== -1) subscriptions.splice(idx, 1);
    }),
    onEnvelope: mock(
      (event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
        subscriptions.push({ event, handler });
      },
    ) as unknown as SlingshotEventBus['onEnvelope'],
    offEnvelope: mock(
      (event: string, handler: (p: Record<string, unknown>) => void | Promise<void>) => {
        const idx = subscriptions.findIndex(s => s.event === event && s.handler === handler);
        if (idx !== -1) subscriptions.splice(idx, 1);
      },
    ) as unknown as SlingshotEventBus['offEnvelope'],
    emitted,
    subscriptions,
  };
}

function createSetupContext(
  app: import('hono').Hono<AppEnv>,
  config: ReturnType<typeof createFramework>,
  bus: ReturnType<typeof createBus>,
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

    const setupContext = createSetupContext(app, fw, bus);
    await plugin.setupMiddleware!(setupContext);
    await plugin.setupRoutes!(setupContext);

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

    const setupContext = createSetupContext(app, fw, bus);
    await plugin.setupMiddleware!(setupContext);
    await plugin.setupRoutes!(setupContext);

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

    const setupContext = createSetupContext(app, fw, bus);
    await plugin.setupMiddleware!(setupContext);
    await plugin.setupRoutes!(setupContext);

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

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    // Fire the cascade event
    const sub = bus.subscriptions.find(s => s.event === 'note:deleted')!;
    expect(sub).toBeDefined();
    await sub.handler({ id: '10' });

    const { items } = await commentAdapter.list({});
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).noteId).toBe('99');
  });

  it('setupPost stays quiet for entities without post-phase subscriptions', async () => {
    const plugin = createEntityPlugin({
      name: 'notes-plugin',
      entities: [
        {
          config: noteEntity,
          buildAdapter: () => noteAdapter,
        },
      ],
    });

    await plugin.setupPost!(createSetupContext(app, fw, bus));

    expect(bus.subscriptions).toHaveLength(0);
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

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));
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
      entities: [{ config: noteEntity, factories }],
    });

    const setupContext = createSetupContext(app, fw, bus);
    await plugin.setupMiddleware!(setupContext);
    await plugin.setupRoutes!(setupContext);

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
          factories,
          onAdapter: (a: BareEntityAdapter) => {
            adapterRef = a;
          },
        },
      ],
    });

    await plugin.setupRoutes!(createSetupContext(app, fw, bus));

    expect(adapterRef).toBeDefined();
    const record = await adapterRef!.create({ text: 'via ref', authorId: 'user-1' });
    expect((record as Record<string, unknown>).text).toBe('via ref');
    expect((record as Record<string, unknown>).id).toBeDefined();
  });
});


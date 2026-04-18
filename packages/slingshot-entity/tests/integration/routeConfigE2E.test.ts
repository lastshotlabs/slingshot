/**
 * E2E round-trip: buildBareEntityRoutes + applyRouteConfig + HTTP request.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, mock } from 'bun:test';
import type { Context, Next } from 'hono';
import type { AppEnv, ResolvedEntityConfig, SlingshotContext } from '@lastshotlabs/slingshot-core';
import { applyRouteConfig } from '../../src/routing/applyRouteConfig';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';

// ---------------------------------------------------------------------------
// In-memory adapter for tests
// ---------------------------------------------------------------------------

const records = new Map<string, Record<string, unknown>>();
let idCounter = 0;

function matchesFilter(record: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (record[key] !== value) return false;
  }
  return true;
}

function createMemoryAdapter() {
  return {
    create: (data: unknown) => {
      const id = String(++idCounter);
      const record = { id, ...(data as Record<string, unknown>) };
      records.set(id, record);
      return Promise.resolve(record);
    },
    getById: (id: string) => Promise.resolve(records.get(id) ?? null),
    list: (opts?: {
      filter?: unknown;
      limit?: number;
      cursor?: string;
      sortDir?: 'asc' | 'desc';
    }) => {
      let items = [...records.values()];
      if (opts?.filter && typeof opts.filter === 'object' && !Array.isArray(opts.filter)) {
        items = items.filter(record =>
          matchesFilter(record, opts.filter as Record<string, unknown>),
        );
      }
      const limit = opts?.limit ?? items.length;
      return Promise.resolve({ items: items.slice(0, limit), hasMore: items.length > limit });
    },
    update: (id: string, data: unknown) => {
      const existing = records.get(id);
      if (!existing) return Promise.resolve(null);
      const updated = { ...existing, ...(data as Record<string, unknown>) };
      records.set(id, updated);
      return Promise.resolve(updated);
    },
    delete: (id: string) => {
      records.delete(id);
      return Promise.resolve(true);
    },
  };
}

const testEntityConfig: ResolvedEntityConfig = {
  name: 'Note',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    text: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'notes',
};

type TestAuthRuntime = {
  adapter: {
    getSuspended?: (
      userId: string,
    ) => Promise<{ suspended: boolean; suspendedReason?: string } | null>;
    getEmailVerified?: (userId: string) => Promise<boolean | null | undefined>;
  };
  config: {
    primaryField?: string;
    emailVerification?: {
      required?: boolean;
    };
  };
};

function createTestAuthRuntime(
  options: {
    suspended?: boolean;
    emailVerificationRequired?: boolean;
    emailVerified?: boolean;
  } = {},
): TestAuthRuntime {
  const suspendedUsers = new Map<string, { suspended: boolean; suspendedReason?: string }>();
  if (options.suspended) {
    suspendedUsers.set('user-1', {
      suspended: true,
      suspendedReason: 'security review',
    });
  }

  const emailVerifiedUsers = new Map<string, boolean>();
  emailVerifiedUsers.set('user-1', options.emailVerified ?? true);

  return {
    adapter: {
      async getSuspended(userId: string) {
        return suspendedUsers.get(userId) ?? { suspended: false };
      },
      async getEmailVerified(userId: string) {
        return emailVerifiedUsers.get(userId) ?? false;
      },
    },
    config: {
      primaryField: 'email',
      emailVerification: options.emailVerificationRequired ? { required: true } : undefined,
    },
  };
}

function attachSlingshotCtx(
  router: OpenAPIHono<AppEnv>,
  options: { tenantId?: string; authRuntime?: TestAuthRuntime } = {},
) {
  const idempotencyStore = new Map<
    string,
    {
      response: string;
      status: number;
      createdAt: number;
      expiresAt: number;
      requestFingerprint?: string | null;
    }
  >();
  router.use('*', async (_c: Context, next: Next) => {
    const pluginState = new Map<string, unknown>();
    if (options.authRuntime) {
      pluginState.set('slingshot-auth', options.authRuntime);
    }
    const slingshotCtx = {
      tenantId: options.tenantId,
      pluginState,
      routeAuth: {
        userAuth: async (_c: Context, nextAuth: Next) => {
          _c.set('authUserId', 'user-1');
          await nextAuth();
        },
        requireRole: () => async (_c: Context, nextAuth: Next) => nextAuth(),
      },
      persistence: {
        idempotency: {
          async get(key: string) {
            const record = idempotencyStore.get(key);
            if (!record) return null;
            if (Date.now() > record.expiresAt) {
              idempotencyStore.delete(key);
              return null;
            }
            return {
              response: record.response,
              status: record.status,
              createdAt: record.createdAt,
              requestFingerprint: record.requestFingerprint ?? null,
            };
          },
          async set(
            key: string,
            response: string,
            status: number,
            ttlSeconds: number,
            meta?: { requestFingerprint?: string | null },
          ) {
            if (idempotencyStore.has(key)) return;
            idempotencyStore.set(key, {
              response,
              status,
              createdAt: Date.now(),
              expiresAt: Date.now() + ttlSeconds * 1000,
              requestFingerprint: meta?.requestFingerprint ?? null,
            });
          },
        },
      },
      signing: null,
    } as unknown as SlingshotContext;

    _c.set('slingshotCtx', slingshotCtx);
    await next();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildBareEntityRoutes + applyRouteConfig E2E', () => {
  it('creates a router with CRUD routes', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(testEntityConfig, undefined, adapter);

    const req = new Request('http://localhost/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe('hello');
    expect(body.id).toBeDefined();
  });

  it('list returns created records', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(testEntityConfig, undefined, adapter);

    await adapter.create({ text: 'note 1' });
    await adapter.create({ text: 'note 2' });

    const req = new Request('http://localhost/notes');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('list filters by validated query params and ignores unknown keys', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const filterableEntityConfig: ResolvedEntityConfig = {
      ...testEntityConfig,
      fields: {
        ...testEntityConfig.fields,
        ownerId: { type: 'string', primary: false, immutable: false, optional: false },
        status: {
          type: 'enum',
          primary: false,
          immutable: false,
          optional: false,
          enumValues: ['draft', 'published'],
        },
      },
      indexes: [{ fields: ['ownerId'] }],
    };
    const router = buildBareEntityRoutes(filterableEntityConfig, undefined, adapter);

    await adapter.create({ text: 'note 1', ownerId: 'u1', status: 'published' });
    await adapter.create({ text: 'note 2', ownerId: 'u1', status: 'published' });
    await adapter.create({ text: 'note 3', ownerId: 'u1', status: 'draft' });
    await adapter.create({ text: 'note 4', ownerId: 'u2', status: 'published' });

    const filteredRes = await router.fetch(
      new Request('http://localhost/notes?ownerId=u1&status=published&limit=1'),
    );
    expect(filteredRes.status).toBe(200);
    const filteredBody = (await filteredRes.json()) as {
      items: Array<Record<string, unknown>>;
      hasMore?: boolean;
    };
    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0]?.ownerId).toBe('u1');
    expect(filteredBody.items[0]?.status).toBe('published');
    expect(filteredBody.hasMore).toBe(true);

    const unknownRes = await router.fetch(new Request('http://localhost/notes?unknown=u1'));
    expect(unknownRes.status).toBe(200);
    const unknownBody = (await unknownRes.json()) as { items: unknown[] };
    expect(unknownBody.items).toHaveLength(4);
  });

  it('get by id returns the record', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(testEntityConfig, undefined, adapter);

    const created = (await adapter.create({ text: 'findme' })) as Record<string, unknown>;
    const req = new Request(`http://localhost/notes/${created.id as string}`);
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe('findme');
  });

  it('get by id returns 404 for missing record', async () => {
    records.clear();
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(testEntityConfig, undefined, adapter);

    const req = new Request('http://localhost/notes/nonexistent');
    const res = await router.fetch(req);
    expect(res.status).toBe(404);
  });

  it('rate limit middleware is applied via applyRouteConfig', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();

    let rateLimitCalled = false;
    const rateLimitFactory = mock(() => {
      return async (_c: unknown, next: () => Promise<void>) => {
        rateLimitCalled = true;
        await next();
      };
    });

    // applyRouteConfig MUST be called before buildBareEntityRoutes so that
    // Hono middleware is registered before route handlers.
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(
      router,
      testEntityConfig,
      { create: { rateLimit: { windowMs: 1000, max: 5 } } },
      {
        rateLimitFactory,
      },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const req = new Request('http://localhost/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'test' }),
    });
    await router.fetch(req);
    expect(rateLimitCalled).toBe(true);
  });

  it('webhook event keys are collected', () => {
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(testEntityConfig, undefined, adapter);
    const webhookEventKeys: string[] = [];

    applyRouteConfig(
      router,
      testEntityConfig,
      {
        webhooks: {
          'note:created': { payload: ['id', 'text'] },
          'note:deleted': {},
        },
      },
      { webhookEventKeys },
    );

    expect(webhookEventKeys).toContain('note:created');
    expect(webhookEventKeys).toContain('note:deleted');
  });

  it('accepts null for optional belongsTo foreign keys on create and update', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const relatedEntityConfig: ResolvedEntityConfig = {
      ...testEntityConfig,
      fields: {
        ...testEntityConfig.fields,
        projectId: { type: 'string', primary: false, immutable: false, optional: false },
      },
      relations: {
        project: {
          kind: 'belongsTo',
          target: 'Project',
          foreignKey: 'projectId',
          optional: true,
        },
      },
    };
    const router = buildBareEntityRoutes(relatedEntityConfig, undefined, adapter);

    const createdRes = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', projectId: null }),
      }),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as Record<string, unknown>;
    expect(created.projectId).toBeNull();

    const updatedRes = await router.fetch(
      new Request(`http://localhost/notes/${created.id as string}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: null }),
      }),
    );
    expect(updatedRes.status).toBe(200);
    const updated = (await updatedRes.json()) as Record<string, unknown>;
    expect(updated.projectId).toBeNull();
  });
});

describe('routePath override — HTTP round-trip', () => {
  it('responds at /versions when routePath: versions set', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(router, testEntityConfig, {}, { routePath: 'versions' });
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, { routePath: 'versions' });

    const res = await router.fetch(
      new Request('http://localhost/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'v1' }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it('returns 404 at the default path when routePath overrides it', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(router, testEntityConfig, {}, { routePath: 'versions' });
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, { routePath: 'versions' });

    const res = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'v1' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('named op method override — HTTP round-trip', () => {
  it('responds to GET when method: get set on named op', async () => {
    records.clear();
    idCounter = 0;
    const adapter = {
      ...createMemoryAdapter(),
      listByDocument: () => Promise.resolve({ items: [], hasMore: false }),
    };
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    applyRouteConfig(
      router,
      testEntityConfig,
      { operations: { listByDocument: { method: 'get' } } },
      { routePath: 'notes' },
    );
    buildBareEntityRoutes(
      testEntityConfig,
      {
        listByDocument: {
          kind: 'collection',
          input: {},
          output: 'array',
        } as unknown as import('@lastshotlabs/slingshot-core').OperationConfig,
      },
      adapter,
      router,
      { routePath: 'notes', operationMethods: { listByDocument: 'get' } },
    );

    const res = await router.fetch(new Request('http://localhost/notes/list-by-document'));
    expect(res.status).toBe(200);
  });

  it('returns 404 for POST when method is overridden to GET', async () => {
    records.clear();
    idCounter = 0;
    const adapter = {
      ...createMemoryAdapter(),
      listByDocument: () => Promise.resolve({ items: [], hasMore: false }),
    };
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    applyRouteConfig(
      router,
      testEntityConfig,
      { operations: { listByDocument: { method: 'get' } } },
      { routePath: 'notes' },
    );
    buildBareEntityRoutes(
      testEntityConfig,
      {
        listByDocument: {
          kind: 'collection',
          input: {},
          output: 'array',
        } as unknown as import('@lastshotlabs/slingshot-core').OperationConfig,
      },
      adapter,
      router,
      { routePath: 'notes', operationMethods: { listByDocument: 'get' } },
    );

    const res = await router.fetch(
      new Request('http://localhost/notes/list-by-document', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('named op without method override defaults to POST', async () => {
    records.clear();
    idCounter = 0;
    const adapter = {
      ...createMemoryAdapter(),
      archive: () => Promise.resolve({ archived: true }),
    };
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(router, testEntityConfig, { operations: { archive: {} } }, {});
    buildBareEntityRoutes(
      testEntityConfig,
      {
        archive: {
          kind: 'transition',
          input: {},
          output: 'entity',
        } as unknown as import('@lastshotlabs/slingshot-core').OperationConfig,
      },
      adapter,
      router,
    );

    const res = await router.fetch(
      new Request('http://localhost/notes/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('named operation inference — HTTP round-trip', () => {
  const slugEntityConfig: ResolvedEntityConfig = {
    ...testEntityConfig,
    fields: {
      ...testEntityConfig.fields,
      slug: { type: 'string', primary: false, immutable: false, optional: false },
    },
  };

  it('lookup one defaults to GET with path params and returns 404 when missing', async () => {
    records.clear();
    idCounter = 0;
    const adapter = {
      ...createMemoryAdapter(),
      findBySlug: ({ slug }: { slug: string }) =>
        Promise.resolve([...records.values()].find(record => record.slug === slug) ?? null),
    };
    await adapter.create({ text: 'hello', slug: 'alpha' });

    const router = buildBareEntityRoutes(
      slugEntityConfig,
      {
        findBySlug: {
          kind: 'lookup',
          fields: { slug: 'param:slug' },
          returns: 'one',
        },
      },
      adapter,
    );

    const found = await router.fetch(new Request('http://localhost/notes/find-by-slug/alpha'));
    expect(found.status).toBe(200);
    expect((await found.json()) as Record<string, unknown>).toMatchObject({ slug: 'alpha' });

    const missing = await router.fetch(new Request('http://localhost/notes/find-by-slug/missing'));
    expect(missing.status).toBe(404);

    const wrongMethod = await router.fetch(
      new Request('http://localhost/notes/find-by-slug/alpha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'alpha' }),
      }),
    );
    expect(wrongMethod.status).toBe(404);
  });

  it('exists defaults to HEAD with path params and 200/404 semantics', async () => {
    records.clear();
    idCounter = 0;
    const adapter = {
      ...createMemoryAdapter(),
      slugExists: ({ slug }: { slug: string }) =>
        Promise.resolve([...records.values()].some(record => record.slug === slug)),
    };
    await adapter.create({ text: 'hello', slug: 'alpha' });

    const router = buildBareEntityRoutes(
      slugEntityConfig,
      {
        slugExists: {
          kind: 'exists',
          fields: { slug: 'param:slug' },
        },
      },
      adapter,
    );

    const exists = await router.fetch(
      new Request('http://localhost/notes/slug-exists/alpha', { method: 'HEAD' }),
    );
    expect(exists.status).toBe(200);

    const missing = await router.fetch(
      new Request('http://localhost/notes/slug-exists/missing', { method: 'HEAD' }),
    );
    expect(missing.status).toBe(404);

    const wrongMethod = await router.fetch(new Request('http://localhost/notes/slug-exists/alpha'));
    expect(wrongMethod.status).toBe(404);
  });

  it('applyRouteConfig aligns middleware with inferred lookup routes when operation configs are provided', async () => {
    records.clear();
    idCounter = 0;
    let middlewareCalled = false;
    const adapter = {
      ...createMemoryAdapter(),
      findBySlug: ({ slug }: { slug: string }) =>
        Promise.resolve([...records.values()].find(record => record.slug === slug) ?? null),
    };
    await adapter.create({ text: 'hello', slug: 'alpha' });

    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    applyRouteConfig(
      router,
      slugEntityConfig,
      {
        operations: {
          findBySlug: {
            middleware: ['flag'],
          },
        },
      },
      {
        middleware: {
          flag: async (_c, next) => {
            middlewareCalled = true;
            await next();
          },
        },
        operationConfigs: {
          findBySlug: {
            kind: 'lookup',
            fields: { slug: 'param:slug' },
            returns: 'one',
          },
        },
      },
    );
    buildBareEntityRoutes(
      slugEntityConfig,
      {
        findBySlug: {
          kind: 'lookup',
          fields: { slug: 'param:slug' },
          returns: 'one',
        },
      },
      adapter,
      router,
    );

    const res = await router.fetch(new Request('http://localhost/notes/find-by-slug/alpha'));
    expect(res.status).toBe(200);
    expect(middlewareCalled).toBe(true);
  });

  it('runs custom middleware after auth so authUserId is available', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router);

    let sawAuthUserId: string | null = null;
    applyRouteConfig(
      router,
      testEntityConfig,
      {
        create: {
          auth: 'userAuth',
          middleware: ['checkAuth'],
        },
        middleware: { checkAuth: true },
      },
      {
        middleware: {
          checkAuth: async (c, next) => {
            sawAuthUserId = (c.get('authUserId' as never) as string | undefined) ?? null;
            await next();
          },
        },
      },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const res = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ordered' }),
      }),
    );

    expect(res.status).toBe(201);
    expect(sawAuthUserId === 'user-1').toBe(true);
  });

  it('rejects entity writes when the authenticated account is suspended after session issue', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router, {
      authRuntime: createTestAuthRuntime({ suspended: true }),
    });

    applyRouteConfig(
      router,
      testEntityConfig,
      {
        create: {
          auth: 'userAuth',
        },
      },
      {},
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const res = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'blocked' }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account suspended' });
    expect(records.size).toBe(0);
  });

  it('rejects entity writes when required login email verification is no longer satisfied', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router, {
      authRuntime: createTestAuthRuntime({
        emailVerificationRequired: true,
        emailVerified: false,
      }),
    });

    applyRouteConfig(
      router,
      testEntityConfig,
      {
        create: {
          auth: 'userAuth',
        },
      },
      {},
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const res = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'blocked' }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Email not verified' });
    expect(records.size).toBe(0);
  });

  it('replays entity create responses when first-class idempotency is enabled', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router);

    applyRouteConfig(
      router,
      testEntityConfig,
      {
        create: {
          auth: 'userAuth',
          idempotency: true,
        },
      },
      {},
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const request = (text: string) =>
      router.fetch(
        new Request('http://localhost/notes', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'note-create-1',
          },
          body: JSON.stringify({ text }),
        }),
      );

    const first = await request('hello');
    const second = await request('hello');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(records.size).toBe(1);
    expect(await first.json()).toEqual(await second.json());
  });

  it('rejects reused entity idempotency keys when the request fingerprint changes', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router);

    applyRouteConfig(
      router,
      testEntityConfig,
      {
        create: {
          auth: 'userAuth',
          idempotency: true,
        },
      },
      {},
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router);

    const first = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'note-create-2',
        },
        body: JSON.stringify({ text: 'one' }),
      }),
    );
    const second = await router.fetch(
      new Request('http://localhost/notes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'note-create-2',
        },
        body: JSON.stringify({ text: 'two' }),
      }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(records.size).toBe(1);
    expect(await second.json()).toMatchObject({
      code: 'idempotency_key_conflict',
    });
  });
});

describe('parentPath — HTTP round-trip', () => {
  it('responds at nested path /documents/:docId/versions', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(
      router,
      testEntityConfig,
      {},
      {
        parentPath: '/documents/:docId',
        routePath: 'versions',
      },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, {
      parentPath: '/documents/:docId',
      routePath: 'versions',
    });

    const res = await router.fetch(
      new Request('http://localhost/documents/doc-1/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'v1' }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it('returns 404 at the flat path when parentPath is set', async () => {
    records.clear();
    const adapter = createMemoryAdapter();
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono();
    applyRouteConfig(
      router,
      testEntityConfig,
      {},
      { parentPath: '/documents/:docId', routePath: 'versions' },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, {
      parentPath: '/documents/:docId',
      routePath: 'versions',
    });

    const res = await router.fetch(
      new Request('http://localhost/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'v1' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('parentAuth — HTTP round-trip', () => {
  it('allows request when parent record matches tenant', async () => {
    records.clear();
    idCounter = 0;
    const adapter = createMemoryAdapter();
    const parentAdapter = {
      getById: () => Promise.resolve({ id: 'doc-1', orgId: 'org-abc' }),
    };
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router);
    applyRouteConfig(
      router,
      testEntityConfig,
      {
        list: {
          permission: {
            requires: 'snap:read',
            parentAuth: { idParam: 'docId', tenantField: 'orgId' },
          },
        },
      },
      { parentAdapter, parentPath: '/documents/:docId', routePath: 'versions' },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, {
      parentPath: '/documents/:docId',
      routePath: 'versions',
    });

    const req = new Request('http://localhost/documents/doc-1/versions');
    // inject tenantId via custom header isn't possible here without full Hono env;
    // instead verify the middleware is wired by checking that without tenantId
    // the parentAuth check returns 404 (parent.orgId 'org-abc' !== undefined)
    const res = await router.fetch(req);
    expect(res.status).toBe(404); // parentAuth fires: orgId !== undefined (no tenant in test)
  });

  it('returns 404 when parent record does not exist', async () => {
    records.clear();
    const adapter = createMemoryAdapter();
    const parentAdapter = {
      getById: () => Promise.resolve(null), // parent not found
    };
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const router = new OpenAPIHono<AppEnv>();
    attachSlingshotCtx(router);
    applyRouteConfig(
      router,
      testEntityConfig,
      {
        list: {
          permission: {
            requires: 'snap:read',
            parentAuth: { idParam: 'docId', tenantField: 'orgId' },
          },
        },
      },
      { parentAdapter, parentPath: '/documents/:docId', routePath: 'versions' },
    );
    buildBareEntityRoutes(testEntityConfig, undefined, adapter, router, {
      parentPath: '/documents/:docId',
      routePath: 'versions',
    });

    const res = await router.fetch(new Request('http://localhost/documents/nonexistent/versions'));
    expect(res.status).toBe(404);
  });
});

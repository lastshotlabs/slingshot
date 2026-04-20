import { describe, expect, mock, test } from 'bun:test';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../src/context';
import { attachContext } from '../../src/context/contextStore';
import {
  freezeEntityPolicyRegistry,
  getEntityPolicyResolver,
  getOrCreateEntityPolicyRegistry,
  registerEntityPolicy,
} from '../../src/entityPolicy';
import { defineHandler } from '../../src/handler';
import {
  enforceDataScope,
  idempotent,
  rejectScopedFields,
  requireAuth,
  requireUserAuth,
} from '../../src/guards';
import { createDefaultIdentityResolver } from '../../src/identity';
import { mount, toRoute, toRouteHandler } from '../../src/mount';
import { z } from 'zod';

function createContextFixture(overrides: Record<string, unknown> = {}) {
  const app = new Hono<AppEnv>();
  const emitted: Array<{ key: string; payload: unknown }> = [];
  const idempotency = {
    get: mock(async () => null),
    set: mock(async () => {}),
  };
  const ctx = {
    app,
    config: {},
    persistence: { idempotency },
    identityResolver: createDefaultIdentityResolver(),
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map(),
    adapters: {},
    bus: {
      emit(key: string, payload: unknown) {
        emitted.push({ key, payload });
      },
    },
    signing: null,
    ...overrides,
  };

  attachContext(app, ctx as never);
  return { app, ctx: ctx as never, emitted, idempotency };
}

function createArgs(
  ctx: unknown,
  input: Record<string, unknown> = {},
  overrides: Partial<{
    authUserId: string | null;
    tenantId: string | null;
    idempotencyKey: string | undefined;
  }> = {},
) {
  return {
    ctx,
    input,
    handlerName: 'items.update',
    meta: {
      requestId: 'req-1',
      tenantId: overrides.tenantId ?? 'tenant-1',
      authUserId: 'authUserId' in overrides ? (overrides.authUserId ?? null) : 'user-1',
      correlationId: 'corr-1',
      ip: '127.0.0.1',
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    },
  };
}

describe('entity policy, guards, and mounting', () => {
  test('entity policy registry resolves per app and freezes after route assembly', () => {
    const { app, ctx } = createContextFixture();
    const registry = getOrCreateEntityPolicyRegistry((ctx as { pluginState: Map<string, unknown> }).pluginState);
    const resolver = async () => true;

    expect(registry.resolvers.size).toBe(0);

    registerEntityPolicy(app, 'items:read', resolver);
    expect(getEntityPolicyResolver(app, 'items:read')).toBe(resolver);

    freezeEntityPolicyRegistry(app);
    expect(() => registerEntityPolicy(app, 'items:write', resolver)).toThrow(/frozen/);
  });

  test('requireAuth, enforceDataScope, and rejectScopedFields enforce real request constraints', async () => {
    const { ctx } = createContextFixture();

    await expect(
      requireAuth()(createArgs(ctx, {}, { authUserId: null }) as never),
    ).rejects.toMatchObject({ status: 401 });

    const createInput: Record<string, unknown> = { title: 'Hello' };
    await enforceDataScope({ field: 'tenantId', from: 'ctx:tenantId' }, { op: 'create' })(
      createArgs(ctx, createInput) as never,
    );
    expect(createInput).toMatchObject({ tenantId: 'tenant-1' });

    const listInput: Record<string, unknown> = {};
    await enforceDataScope({ field: 'tenantId', from: 'ctx:tenantId' }, { op: 'list' })(
      createArgs(ctx, listInput) as never,
    );
    expect(listInput).toMatchObject({
      tenantId: 'tenant-1',
      _scopeFilter: { tenantId: 'tenant-1' },
    });

    await expect(
      rejectScopedFields(['tenantId'])(createArgs(ctx, { tenantId: 'tenant-2' }) as never),
    ).rejects.toMatchObject({
      status: 400,
      details: { field: 'tenantId' },
    });
  });

  test('idempotent stores request fingerprints and cached responses', async () => {
    const { ctx, idempotency } = createContextFixture();
    const guard = idempotent({ ttl: 90, scope: 'tenant' });
    const args = createArgs(ctx, { name: 'General' }, { idempotencyKey: 'idem-1' });

    await guard(args as never);
    expect(idempotency.get).toHaveBeenCalledTimes(1);

    const afterHook = (guard as { _afterHook: (args: unknown) => Promise<void> })._afterHook;
    await afterHook({ ...args, output: { id: 'item-1' } });

    expect(idempotency.set).toHaveBeenCalledTimes(1);
    expect(idempotency.set.mock.calls[0]?.[0]).toContain('idempotency:items.update:tenant:tenant-1');
    expect(idempotency.set.mock.calls[0]?.[2]).toBe(200);
    expect(idempotency.set.mock.calls[0]?.[3]).toBe(90);
  });

  test('toRoute and toRouteHandler build real HTTP surfaces for handlers', async () => {
    const routeAuth = {
      userAuth: async (c: Context<AppEnv>, next: () => Promise<void>) => {
        c.set('authUserId', 'user-1');
        await next();
      },
      bearerAuth: async (c: Context<AppEnv>, next: () => Promise<void>) => {
        c.set('bearerClientId', 'client-1');
        await next();
      },
      requireRole: () => async (_c: Context<AppEnv>, next: () => Promise<void>) => {
        await next();
      },
    };
    const { app, ctx } = createContextFixture({ routeAuth });

    const handler = defineHandler({
      name: 'items.create',
      input: z.object({
        id: z.string(),
        search: z.string().optional(),
        note: z.string().optional(),
      }),
      output: z.object({
        id: z.string(),
        actor: z.string().nullable(),
        note: z.string().nullable(),
        search: z.string().nullable(),
      }),
      guards: [requireUserAuth()],
      handle: async ({ input, meta }) => ({
        id: input.id,
        actor: meta.authUserId,
        note: input.note ?? null,
        search: input.search ?? null,
      }),
    });

    const getRoute = toRoute(handler, { method: 'get', path: '/items' });
    const postRoute = toRoute(handler, { method: 'post', path: '/items/{id}' });
    expect((getRoute as { request: { query?: unknown } }).request.query).toBe(handler.input);
    expect((postRoute as { request: { body?: unknown } }).request.body).toBeDefined();

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      c.set('tenantId', 'tenant-1');
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.post('/items/:id', toRouteHandler(handler, { method: 'post' }));

    const response = await app.request('/items/item-1?search=query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'hello' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: 'item-1',
      actor: 'user-1',
      note: 'hello',
      search: 'query',
    });
  });

  test('mount delegates to the OpenAPI-capable app surface', () => {
    const handler = defineHandler({
      name: 'items.list',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handle: async () => ({ ok: true }),
    });
    const openapi = mock(() => undefined);

    mount({ openapi } as never, handler, { method: 'get', path: '/items' });

    expect(openapi).toHaveBeenCalledTimes(1);
  });
});

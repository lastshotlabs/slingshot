/**
 * Integration tests for the actor identity abstraction across handler invocation,
 * guards, after hooks, data-scope bindings, and HTTP mount surface.
 *
 * Tests the full round-trip: defineHandler -> invoke -> guards see actor ->
 * handler sees actor -> after hooks see actor. Also covers resolveScopedValue
 * bindings and toRouteHandler identity resolution via custom resolvers.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditLog, emitEvent } from '../../src/afterHooks';
import type { AppEnv } from '../../src/context';
import { attachContext } from '../../src/context/contextStore';
import {
  enforceDataScope,
  idempotent,
  rateLimit,
  requireAuth,
  requireBearer,
  requireTenant,
  requireUserAuth,
} from '../../src/guards';
import {
  defineHandler,
  HandlerError,
  resolveActor,
  type HandlerArgs,
  type HandlerMeta,
} from '../../src/handler';
import {
  ANONYMOUS_ACTOR,
  createDefaultIdentityResolver,
  type Actor,
  type IdentityResolver,
} from '../../src/identity';
import { toRouteHandler } from '../../src/mount';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const userActor: Actor = Object.freeze({
  id: 'user-1',
  kind: 'user' as const,
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
  roles: ['admin'],
  claims: { orgId: 'org-42', tier: 'enterprise' },
});

const apiKeyActor: Actor = Object.freeze({
  id: 'key-abc',
  kind: 'api-key' as const,
  tenantId: 'tenant-2',
  sessionId: null,
  roles: ['reader'],
  claims: {},
});

const serviceActor: Actor = Object.freeze({
  id: 'svc-xyz',
  kind: 'service-account' as const,
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: {},
});

const systemActor: Actor = Object.freeze({
  id: 'cron-job',
  kind: 'system' as const,
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: {},
});

function createContextFixture(overrides: Record<string, unknown> = {}) {
  const app = new Hono<AppEnv>();
  const emitted: Array<{ key: string; payload: unknown }> = [];
  const idempotency = {
    get: mock(async () => null),
    set: mock(async () => {}),
  };
  const auditEntries: unknown[] = [];
  const ctx = {
    app,
    config: {},
    persistence: {
      idempotency,
      auditLog: {
        logEntry: mock(async (entry: unknown) => {
          auditEntries.push(entry);
        }),
        getLogs: mock(async () => ({ items: [] })),
      },
    },
    identityResolver: createDefaultIdentityResolver(),
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: {
      trackAttempt: mock(async () => false),
    },
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
  return { app, ctx: ctx as never, emitted, idempotency, auditEntries };
}

function metaWith(actor: Actor, extra: Partial<HandlerMeta> = {}): Partial<HandlerMeta> {
  return {
    requestId: 'req-test',
    actor,
    tenantId: actor.tenantId,
    authUserId: actor.kind === 'user' ? actor.id : null,
    correlationId: 'corr-test',
    ip: '10.0.0.1',
    ...extra,
  };
}

function legacyMeta(
  overrides: Record<string, unknown> = {},
): Partial<HandlerMeta> {
  return {
    requestId: 'req-legacy',
    tenantId: 'tenant-1',
    authUserId: 'user-1',
    correlationId: 'corr-legacy',
    ip: '10.0.0.1',
    ...overrides,
  } as Partial<HandlerMeta>;
}

afterEach(() => {
  mock.restore();
});

// ===========================================================================
// defaultMeta actor integration (Task #11)
// ===========================================================================

describe('defaultMeta actor construction via defineHandler.invoke', () => {
  const echoHandler = defineHandler({
    name: 'echo.actor',
    input: z.object({}),
    output: z.object({
      actorId: z.string().nullable(),
      actorKind: z.string(),
      actorTenantId: z.string().nullable(),
      actorSessionId: z.string().nullable(),
      actorRoles: z.array(z.string()).nullable(),
      legacyAuthUserId: z.string().nullable(),
      legacyTenantId: z.string().nullable(),
    }),
    handle: async ({ meta }) => ({
      actorId: meta.actor.id,
      actorKind: meta.actor.kind,
      actorTenantId: meta.actor.tenantId,
      actorSessionId: meta.actor.sessionId,
      actorRoles: meta.actor.roles,
      legacyAuthUserId: meta.authUserId,
      legacyTenantId: meta.tenantId,
    }),
  });

  test('explicit actor on meta is preserved through invoke', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: metaWith(userActor) });

    expect(result.actorId).toBe('user-1');
    expect(result.actorKind).toBe('user');
    expect(result.actorTenantId).toBe('tenant-1');
    expect(result.actorSessionId).toBe('sess-1');
    expect(result.actorRoles).toEqual(['admin']);
  });

  test('legacy fields are projected from explicit actor', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: metaWith(userActor) });

    expect(result.legacyAuthUserId).toBe('user-1');
    expect(result.legacyTenantId).toBe('tenant-1');
  });

  test('api-key actor projects null authUserId', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: metaWith(apiKeyActor) });

    expect(result.actorId).toBe('key-abc');
    expect(result.actorKind).toBe('api-key');
    expect(result.legacyAuthUserId).toBeNull();
    expect(result.legacyTenantId).toBe('tenant-2');
  });

  test('service-account actor projects null authUserId', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: metaWith(serviceActor) });

    expect(result.actorId).toBe('svc-xyz');
    expect(result.actorKind).toBe('service-account');
    expect(result.legacyAuthUserId).toBeNull();
  });

  test('system actor projects null authUserId', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: metaWith(systemActor) });

    expect(result.actorId).toBe('cron-job');
    expect(result.actorKind).toBe('system');
    expect(result.legacyAuthUserId).toBeNull();
  });

  test('anonymous actor projects null everything', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke(
      {},
      { ctx, meta: metaWith(ANONYMOUS_ACTOR) },
    );

    expect(result.actorId).toBeNull();
    expect(result.actorKind).toBe('anonymous');
    expect(result.legacyAuthUserId).toBeNull();
    expect(result.legacyTenantId).toBeNull();
  });

  test('meta without actor defaults to anonymous', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: legacyMeta() });

    // Without an explicit actor, defaultMeta falls back to ANONYMOUS_ACTOR.
    expect(result.actorId).toBeNull();
    expect(result.actorKind).toBe('anonymous');
    expect(result.legacyAuthUserId).toBeNull();
  });

  test('no meta at all produces anonymous actor', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx });

    expect(result.actorKind).toBe('anonymous');
    expect(result.actorId).toBeNull();
  });

  test('empty partial meta produces anonymous actor', async () => {
    const { ctx } = createContextFixture();
    const result = await echoHandler.invoke({}, { ctx, meta: {} });

    expect(result.actorKind).toBe('anonymous');
    expect(result.actorId).toBeNull();
  });
});

// ===========================================================================
// resolveScopedValue actor bindings (Task #12)
// ===========================================================================

describe('enforceDataScope with actor bindings', () => {
  test('ctx:actor.id resolves from explicit actor', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'ownerId', from: 'ctx:actor.id' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.ownerId).toBe('user-1');
  });

  test('ctx:actor.tenantId resolves from explicit actor', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'tenantId', from: 'ctx:actor.tenantId' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.tenantId).toBe('tenant-1');
  });

  test('ctx:actor.kind resolves the discriminator', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'actorKind', from: 'ctx:actor.kind' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: serviceActor,
        tenantId: null,
        authUserId: null,
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.actorKind).toBe('service-account');
  });

  test('ctx:actor.sessionId resolves from actor', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'sessionId', from: 'ctx:actor.sessionId' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.sessionId).toBe('sess-1');
  });

  test('ctx:actor.claims.orgId resolves a custom claim', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope(
      { field: 'orgId', from: 'ctx:actor.claims.orgId' },
      { op: 'create' },
    )({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.orgId).toBe('org-42');
  });

  test('ctx:actor.claims.tier resolves another custom claim', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope(
      { field: 'tier', from: 'ctx:actor.claims.tier' },
      { op: 'create' },
    )({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.tier).toBe('enterprise');
  });

  test('ctx:actor.claims.missing returns undefined (triggers 401)', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await expect(
      enforceDataScope(
        { field: 'x', from: 'ctx:actor.claims.nonexistent' },
        { op: 'create' },
      )({
        ctx,
        input,
        handlerName: 'test',
        meta: {
          requestId: 'req-1',
          actor: userActor,
          tenantId: 'tenant-1',
          authUserId: 'user-1',
          correlationId: 'corr-1',
          ip: null,
        },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('ctx:actor.claims with numeric claim stringifies it', async () => {
    const actorWithNumericClaim: Actor = {
      ...userActor,
      claims: { level: 42 },
    };
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope(
      { field: 'level', from: 'ctx:actor.claims.level' },
      { op: 'create' },
    )({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: actorWithNumericClaim,
        tenantId: null,
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.level).toBe('42');
  });

  test('legacy ctx:authUserId still works with explicit actor', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'userId', from: 'ctx:authUserId' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.userId).toBe('user-1');
  });

  test('legacy ctx:tenantId still works with explicit actor', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'tenantId', from: 'ctx:tenantId' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        requestTenantId: 'tenant-1',
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.tenantId).toBe('tenant-1');
  });

  test('legacy ctx:authUserId resolves from actor.id (prefers actor)', async () => {
    const actorWithDifferentId: Actor = {
      ...userActor,
      id: 'actor-id-wins',
    };
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'userId', from: 'ctx:authUserId' }, { op: 'create' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: actorWithDifferentId,
        tenantId: 'tenant-1',
        authUserId: 'legacy-id',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    // Actor takes precedence:
    expect(input.userId).toBe('actor-id-wins');
  });

  test('ctx:actor.id with anonymous actor resolves to null and rejects', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await expect(
      enforceDataScope({ field: 'x', from: 'ctx:actor.id' }, { op: 'create' })({
        ctx,
        input,
        handlerName: 'test',
        meta: {
          requestId: 'req-1',
          actor: ANONYMOUS_ACTOR,
          requestTenantId: null,
          tenantId: null,
          authUserId: null,
          correlationId: 'corr-1',
          ip: null,
        },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('list op applies _scopeFilter with actor bindings', async () => {
    const { ctx } = createContextFixture();
    const input: Record<string, unknown> = {};
    await enforceDataScope({ field: 'tenantId', from: 'ctx:actor.tenantId' }, { op: 'list' })({
      ctx,
      input,
      handlerName: 'test',
      meta: {
        requestId: 'req-1',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-1',
        ip: null,
      },
    } as never);
    expect(input.tenantId).toBe('tenant-1');
    expect(input._scopeFilter).toEqual({ tenantId: 'tenant-1' });
  });
});

// ===========================================================================
// Guards with actor (Task #13)
// ===========================================================================

describe('guards with explicit actor', () => {
  test('requireAuth passes for user actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: userActor, tenantId: 'tenant-1', authUserId: 'user-1', correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireAuth passes for api-key actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: apiKeyActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireAuth passes for service-account actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: serviceActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireAuth passes for system actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: systemActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireAuth rejects anonymous actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: ANONYMOUS_ACTOR, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('requireAuth with user actor passes', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: userActor, requestTenantId: null, tenantId: null, authUserId: 'user-1', correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireAuth with anonymous actor rejects', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireAuth()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: ANONYMOUS_ACTOR, requestTenantId: null, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('requireBearer passes for api-key actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireBearer()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: apiKeyActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireBearer passes for service-account actor', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireBearer()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: serviceActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireBearer rejects user actor without bearerClientId', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireBearer()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: {
          requestId: 'r',
          actor: userActor,
          tenantId: 'tenant-1',
          authUserId: 'user-1',
          correlationId: 'r',
          ip: null,
          bearerClientId: null,
          authClientId: null,
        },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('requireTenant passes when actor has tenantId', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireTenant()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: userActor, tenantId: 'tenant-1', authUserId: 'user-1', correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('requireTenant rejects when actor has no tenantId', async () => {
    const { ctx } = createContextFixture();
    await expect(
      requireTenant()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: serviceActor, tenantId: null, authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('requireTenant with anonymous actor that has tenantId passes', async () => {
    const { ctx } = createContextFixture();
    const anonWithTenant: Actor = { ...ANONYMOUS_ACTOR, tenantId: 'tenant-1' };
    await expect(
      requireTenant()({
        ctx,
        input: {},
        handlerName: 'test',
        meta: { requestId: 'r', actor: anonWithTenant, requestTenantId: 'tenant-1', tenantId: 'tenant-1', authUserId: null, correlationId: 'r', ip: null },
      } as never),
    ).resolves.toBeUndefined();
  });

  test('rateLimit uses actor.id for the rate limit key', async () => {
    const trackAttempt = mock(async () => false);
    const { ctx } = createContextFixture({
      rateLimitAdapter: { trackAttempt },
    });
    await rateLimit({ windowMs: 60_000, max: 10 })({
      ctx,
      input: {},
      handlerName: 'things.list',
      meta: { requestId: 'r', actor: apiKeyActor, tenantId: null, authUserId: null, correlationId: 'r', ip: '1.2.3.4' },
    } as never);
    expect(trackAttempt).toHaveBeenCalledTimes(1);
    const key = trackAttempt.mock.calls[0]![0] as string;
    expect(key).toContain('key-abc');
    expect(key).toContain('things.list');
  });

  test('rateLimit falls back to IP for anonymous actor', async () => {
    const trackAttempt = mock(async () => false);
    const { ctx } = createContextFixture({
      rateLimitAdapter: { trackAttempt },
    });
    await rateLimit({ windowMs: 60_000, max: 10 })({
      ctx,
      input: {},
      handlerName: 'things.list',
      meta: { requestId: 'r', actor: ANONYMOUS_ACTOR, tenantId: null, authUserId: null, correlationId: 'r', ip: '8.8.8.8' },
    } as never);
    const key = trackAttempt.mock.calls[0]![0] as string;
    expect(key).toContain('ip:8.8.8.8');
  });

  test('idempotent with user-scoped includes actor.id and actor.tenantId in cache key', async () => {
    const { ctx, idempotency } = createContextFixture();
    const guard = idempotent({ ttl: 60, scope: 'user' });
    await guard({
      ctx,
      input: { x: 1 },
      handlerName: 'items.create',
      meta: {
        requestId: 'r',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'r',
        ip: null,
        idempotencyKey: 'idem-1',
      },
    } as never);
    expect(idempotency.get).toHaveBeenCalledTimes(1);
    const key = idempotency.get.mock.calls[0]![0] as string;
    expect(key).toContain('user:user-1');
    expect(key).toContain('tenant:tenant-1');
    expect(key).toContain('items.create');
  });

  test('idempotent with tenant-scoped uses actor.tenantId', async () => {
    const { ctx, idempotency } = createContextFixture();
    const guard = idempotent({ ttl: 60, scope: 'tenant' });
    await guard({
      ctx,
      input: {},
      handlerName: 'items.create',
      meta: {
        requestId: 'r',
        actor: apiKeyActor,
        tenantId: 'tenant-2',
        authUserId: null,
        correlationId: 'r',
        ip: null,
        idempotencyKey: 'idem-2',
      },
    } as never);
    const key = idempotency.get.mock.calls[0]![0] as string;
    expect(key).toContain('tenant:tenant-2');
    // Should NOT contain user: since scope is tenant
    expect(key).not.toContain('user:');
  });

  test('idempotent user-scoped rejects anonymous actor', async () => {
    const { ctx } = createContextFixture();
    const guard = idempotent({ ttl: 60, scope: 'user' });
    await expect(
      guard({
        ctx,
        input: {},
        handlerName: 'items.create',
        meta: {
          requestId: 'r',
          actor: ANONYMOUS_ACTOR,
          tenantId: null,
          authUserId: null,
          correlationId: 'r',
          ip: null,
          idempotencyKey: 'idem-3',
        },
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });
});

// ===========================================================================
// After hooks with actor (Task #14)
// ===========================================================================

describe('after hooks with actor', () => {
  test('emitEvent includes actorId from explicit actor', async () => {
    const { ctx, emitted } = createContextFixture();
    const hook = emitEvent('item.created', {
      payload: ['id'],
      include: ['actorId', 'tenantId'],
    });
    await hook({
      ctx,
      input: {},
      output: { id: 'item-1' },
      handlerName: 'items.create',
      meta: {
        requestId: 'r',
        actor: apiKeyActor,
        tenantId: 'tenant-2',
        authUserId: null,
        correlationId: 'r',
        ip: null,
      },
    } as never);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.key).toBe('item.created');
    expect(emitted[0]!.payload).toMatchObject({
      id: 'item-1',
      actorId: 'key-abc',
      tenantId: 'tenant-2',
    });
  });

  test('emitEvent includes actorId from user actor', async () => {
    const { ctx, emitted } = createContextFixture();
    const hook = emitEvent('item.created', {
      payload: ['id'],
      include: ['actorId', 'tenantId'],
    });
    await hook({
      ctx,
      input: {},
      output: { id: 'item-1' },
      handlerName: 'items.create',
      meta: {
        requestId: 'r',
        actor: userActor,
        requestTenantId: 'tenant-1',
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'r',
        ip: null,
      },
    } as never);

    expect(emitted[0]!.payload).toMatchObject({
      actorId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  test('auditLog uses actor fields', async () => {
    const { ctx, auditEntries } = createContextFixture();
    const hook = auditLog('item.created');
    await hook({
      ctx,
      input: { name: 'test' },
      output: { id: 'item-1' },
      handlerName: 'items.create',
      meta: {
        requestId: 'req-audit',
        actor: userActor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'corr-audit',
        ip: '10.0.0.1',
      },
    } as never);

    expect(auditEntries).toHaveLength(1);
    const entry = auditEntries[0] as Record<string, unknown>;
    expect(entry.userId).toBe('user-1');
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.action).toBe('item.created');
  });

  test('auditLog with user actor without session', async () => {
    const { ctx, auditEntries } = createContextFixture();
    const actorNoSession: Actor = { id: 'user-2', kind: 'user', tenantId: 'tenant-2', sessionId: null, roles: null, claims: {} };
    const hook = auditLog('item.deleted');
    await hook({
      ctx,
      input: {},
      output: {},
      handlerName: 'items.delete',
      meta: {
        requestId: 'req-audit-2',
        actor: actorNoSession,
        requestTenantId: 'tenant-2',
        tenantId: 'tenant-2',
        authUserId: 'user-2',
        correlationId: 'corr-2',
        ip: '10.0.0.2',
      },
    } as never);

    const entry = auditEntries[0] as Record<string, unknown>;
    expect(entry.userId).toBe('user-2');
    expect(entry.tenantId).toBe('tenant-2');
    expect(entry.sessionId).toBeNull();
  });

  test('auditLog with service-account actor', async () => {
    const { ctx, auditEntries } = createContextFixture();
    const hook = auditLog('config.update');
    await hook({
      ctx,
      input: {},
      output: {},
      handlerName: 'config.update',
      meta: {
        requestId: 'r',
        actor: serviceActor,
        tenantId: null,
        authUserId: null,
        correlationId: 'r',
        ip: null,
      },
    } as never);

    const entry = auditEntries[0] as Record<string, unknown>;
    expect(entry.userId).toBe('svc-xyz');
    expect(entry.tenantId).toBeNull();
    expect(entry.sessionId).toBeNull();
  });
});

// ===========================================================================
// toRouteHandler identity resolution (Task #15)
// ===========================================================================

describe('toRouteHandler identity resolution', () => {
  test('resolves actor via identityResolver from context variables', async () => {
    const { app, ctx } = createContextFixture();

    const handler = defineHandler({
      name: 'test.actor',
      input: z.object({}),
      output: z.object({
        actorId: z.string().nullable(),
        actorKind: z.string(),
        actorTenantId: z.string().nullable(),
      }),
      handle: async ({ meta }) => ({
        actorId: meta.actor.id,
        actorKind: meta.actor.kind,
        actorTenantId: meta.actor.tenantId,
      }),
    });

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-http');
      c.set('authUserId', 'http-user');
      c.set('tenantId', 'http-tenant');
      c.set('sessionId', 'http-sess');
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.get('/test', toRouteHandler(handler, { method: 'get' }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      actorId: 'http-user',
      actorKind: 'user',
      actorTenantId: 'http-tenant',
    });
  });

  test('resolves api-key actor from bearerClientId context var', async () => {
    const { app, ctx } = createContextFixture();

    const handler = defineHandler({
      name: 'test.bearer',
      input: z.object({}),
      output: z.object({ actorId: z.string().nullable(), actorKind: z.string() }),
      handle: async ({ meta }) => ({
        actorId: meta.actor.id,
        actorKind: meta.actor.kind,
      }),
    });

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-http');
      c.set('bearerClientId', 'bearer-key-1');
      c.set('tenantId', 'org-x');
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.get('/test', toRouteHandler(handler, { method: 'get' }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actorId).toBe('bearer-key-1');
    expect(body.actorKind).toBe('api-key');
  });

  test('resolves anonymous when no auth context vars', async () => {
    const { app, ctx } = createContextFixture();

    const handler = defineHandler({
      name: 'test.anon',
      input: z.object({}),
      output: z.object({ actorId: z.string().nullable(), actorKind: z.string() }),
      handle: async ({ meta }) => ({
        actorId: meta.actor.id,
        actorKind: meta.actor.kind,
      }),
    });

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-http');
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.get('/test', toRouteHandler(handler, { method: 'get' }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actorId).toBeNull();
    expect(body.actorKind).toBe('anonymous');
  });

  test('custom identity resolver maps context to custom actor', async () => {
    // A custom resolver that maps bearerClientId to a system actor with claims.
    const customResolver: IdentityResolver = {
      resolve(input) {
        if (input.tokenPayload && typeof input.tokenPayload === 'object') {
          const payload = input.tokenPayload as Record<string, unknown>;
          return {
            id: String(payload.sub ?? input.authUserId),
            kind: 'user',
            tenantId: String(payload.orgId ?? input.tenantId ?? ''),
            sessionId: input.sessionId,
            roles: input.roles,
            claims: { department: payload.department ?? null },
          };
        }
        return ANONYMOUS_ACTOR;
      },
    };

    const { app, ctx } = createContextFixture({ identityResolver: customResolver });

    const handler = defineHandler({
      name: 'test.custom',
      input: z.object({}),
      output: z.object({
        actorId: z.string().nullable(),
        actorKind: z.string(),
        actorTenantId: z.string().nullable(),
        department: z.unknown(),
      }),
      handle: async ({ meta }) => ({
        actorId: meta.actor.id,
        actorKind: meta.actor.kind,
        actorTenantId: meta.actor.tenantId,
        department: meta.actor.claims.department,
      }),
    });

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-http');
      c.set('tokenPayload', { sub: 'gateway-user', orgId: 'org-99', department: 'engineering' });
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.get('/test', toRouteHandler(handler, { method: 'get' }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actorId).toBe('gateway-user');
    expect(body.actorTenantId).toBe('org-99');
    expect(body.department).toBe('engineering');
  });

  test('legacy fields on HandlerMeta are projected from resolved actor', async () => {
    const { app, ctx } = createContextFixture();

    const handler = defineHandler({
      name: 'test.legacy-compat',
      input: z.object({}),
      output: z.object({
        actorId: z.string().nullable(),
        legacyAuthUserId: z.string().nullable(),
        legacyTenantId: z.string().nullable(),
      }),
      handle: async ({ meta }) => ({
        actorId: meta.actor.id,
        legacyAuthUserId: meta.authUserId,
        legacyTenantId: meta.tenantId,
      }),
    });

    app.use('*', async (c, next) => {
      c.set('requestId', 'req-http');
      c.set('authUserId', 'usr-42');
      c.set('tenantId', 'ten-7');
      c.set('slingshotCtx', ctx);
      await next();
    });
    app.get('/test', toRouteHandler(handler, { method: 'get' }));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.actorId).toBe('usr-42');
    expect(body.legacyAuthUserId).toBe('usr-42');
    expect(body.legacyTenantId).toBe('ten-7');
  });
});

// ===========================================================================
// handler.invoke actor round-trip (Task #16)
// ===========================================================================

describe('handler.invoke actor round-trip', () => {
  test('guards see the correct actor during invoke', async () => {
    const seenActors: Actor[] = [];
    const handler = defineHandler({
      name: 'roundtrip.guards',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        async (args: HandlerArgs) => {
          seenActors.push(resolveActor(args.meta));
        },
      ],
      handle: async () => ({ ok: true }),
    });

    const { ctx } = createContextFixture();
    await handler.invoke({}, { ctx, meta: metaWith(apiKeyActor) });

    expect(seenActors).toHaveLength(1);
    expect(seenActors[0]!.id).toBe('key-abc');
    expect(seenActors[0]!.kind).toBe('api-key');
  });

  test('after hooks see the correct actor during invoke', async () => {
    const seenActors: Actor[] = [];
    const handler = defineHandler({
      name: 'roundtrip.after',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      after: [
        async (args) => {
          seenActors.push(resolveActor(args.meta));
        },
      ],
      handle: async () => ({ ok: true }),
    });

    const { ctx } = createContextFixture();
    await handler.invoke({}, { ctx, meta: metaWith(serviceActor) });

    expect(seenActors).toHaveLength(1);
    expect(seenActors[0]!.id).toBe('svc-xyz');
    expect(seenActors[0]!.kind).toBe('service-account');
  });

  test('guard paired after hook sees same actor', async () => {
    let guardActor: Actor | null = null;
    let afterActor: Actor | null = null;

    const guard = async (args: HandlerArgs) => {
      guardActor = resolveActor(args.meta);
    };
    const afterHook = async (args: HandlerArgs & { output: unknown }) => {
      afterActor = resolveActor(args.meta);
    };
    Object.defineProperty(guard, '_afterHook', { value: afterHook });

    const handler = defineHandler({
      name: 'roundtrip.paired',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [guard],
      handle: async () => ({ ok: true }),
    });

    const { ctx } = createContextFixture();
    await handler.invoke({}, { ctx, meta: metaWith(userActor) });

    expect(guardActor).not.toBeNull();
    expect(afterActor).not.toBeNull();
    expect(guardActor!.id).toBe(afterActor!.id);
    expect(guardActor!.kind).toBe(afterActor!.kind);
  });

  test('multiple guards each see the same actor', async () => {
    const seenActors: Actor[] = [];
    const handler = defineHandler({
      name: 'roundtrip.multi',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      guards: [
        async (args) => { seenActors.push(resolveActor(args.meta)); },
        async (args) => { seenActors.push(resolveActor(args.meta)); },
        async (args) => { seenActors.push(resolveActor(args.meta)); },
      ],
      handle: async () => ({ ok: true }),
    });

    const { ctx } = createContextFixture();
    await handler.invoke({}, { ctx, meta: metaWith(userActor) });

    expect(seenActors).toHaveLength(3);
    for (const a of seenActors) {
      expect(a).toBe(userActor);
    }
  });

  test('handler receives actor with custom claims', async () => {
    const customActor: Actor = {
      id: 'gateway-user',
      kind: 'user',
      tenantId: 'org-99',
      sessionId: null,
      roles: ['admin'],
      claims: { department: 'engineering', level: 5 },
    };

    const handler = defineHandler({
      name: 'roundtrip.claims',
      input: z.object({}),
      output: z.object({
        department: z.unknown(),
        level: z.unknown(),
      }),
      handle: async ({ meta }) => ({
        department: meta.actor.claims.department,
        level: meta.actor.claims.level,
      }),
    });

    const { ctx } = createContextFixture();
    const result = await handler.invoke({}, { ctx, meta: metaWith(customActor) });
    expect(result.department).toBe('engineering');
    expect(result.level).toBe(5);
  });
});

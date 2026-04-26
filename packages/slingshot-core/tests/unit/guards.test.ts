import { describe, expect, test } from 'bun:test';
import { AUTH_PLUGIN_STATE_KEY } from '../../src/authPeer';
import { requireBearer, requireUserAuth } from '../../src/guards';
import { HandlerError, type HandlerMeta } from '../../src/handler';
import { ANONYMOUS_ACTOR, type Actor, createDefaultIdentityResolver } from '../../src/identity';

function createContextFixture() {
  return {
    app: {},
    appName: 'test-app',
    config: {},
    redis: null,
    mongo: null,
    sqlite: null,
    sqliteDb: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    wsEndpoints: null,
    wsPublish: null,
    persistence: {
      idempotency: {
        async get() {
          return null;
        },
        async set() {},
      },
      auditLog: {
        async logEntry() {},
        async getLogs() {
          return { items: [] };
        },
      },
    },
    pluginState: new Map(),
    publicPaths: new Set(),
    plugins: [],
    bus: {
      emit() {},
      on() {},
      off() {},
    },
    adapters: {},
    routeAuth: null,
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
    rateLimitAdapter: {
      async trackAttempt() {
        return false;
      },
    },
    fingerprintBuilder: {
      async buildFingerprint() {
        return 'fp';
      },
    },
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    upload: null,
    metrics: {
      counters: new Map(),
      histograms: new Map(),
      gaugeCallbacks: new Map(),
      queues: null,
    },
    secrets: {},
    resolvedSecrets: {},
    async clear() {},
    async destroy() {},
  };
}

function createMeta(overrides: Partial<HandlerMeta> & { actor: Actor }): HandlerMeta {
  return {
    requestId: 'req-1',
    correlationId: 'req-1',
    requestTenantId: overrides.actor.tenantId ?? null,
    ip: null,
    ...overrides,
  };
}

describe('requireBearer', () => {
  test('allows api-key actor', async () => {
    const guard = requireBearer();
    const actor: Actor = {
      id: 'key-1',
      kind: 'api-key',
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    };

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ actor }),
      } as never),
    ).resolves.toBeUndefined();
  });

  test('allows service-account actor', async () => {
    const guard = requireBearer();
    const actor: Actor = {
      id: 'svc-1',
      kind: 'service-account',
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    };

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ actor }),
      } as never),
    ).resolves.toBeUndefined();
  });

  test('rejects user actor', async () => {
    const guard = requireBearer();
    const actor: Actor = {
      id: 'user-1',
      kind: 'user',
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    };

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ actor }),
      } as never),
    ).rejects.toMatchObject<Partial<HandlerError>>({
      message: 'Unauthorized',
      status: 401,
    });
  });

  test('rejects anonymous actor', async () => {
    const guard = requireBearer();

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ actor: ANONYMOUS_ACTOR }),
      } as never),
    ).rejects.toMatchObject<Partial<HandlerError>>({
      message: 'Unauthorized',
      status: 401,
    });
  });
});

describe('requireUserAuth', () => {
  const userActor: Actor = {
    id: 'user-1',
    kind: 'user',
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: {},
  };

  test('allows authenticated users when the custom access policy passes', async () => {
    const ctx = createContextFixture();
    ctx.pluginState.set(AUTH_PLUGIN_STATE_KEY, {
      adapter: {
        async getSuspended() {
          return { suspended: false };
        },
      },
      evaluateUserAccess: async () => ({ allow: true }),
    });

    await expect(
      requireUserAuth()({
        input: {},
        ctx: ctx as never,
        handlerName: 'items.list',
        meta: createMeta({ actor: userActor }),
      } as never),
    ).resolves.toBeUndefined();
  });

  test('rejects authenticated users when the custom access policy denies access', async () => {
    const ctx = createContextFixture();
    ctx.pluginState.set(AUTH_PLUGIN_STATE_KEY, {
      adapter: {
        async getSuspended() {
          return { suspended: false };
        },
      },
      evaluateUserAccess: async () => ({
        allow: false,
        message: 'Account disabled',
        code: 'account_disabled',
      }),
    });

    await expect(
      requireUserAuth()({
        input: {},
        ctx: ctx as never,
        handlerName: 'items.list',
        meta: createMeta({ actor: userActor }),
      } as never),
    ).rejects.toMatchObject<Partial<HandlerError>>({
      message: 'Account disabled',
      status: 403,
      code: 'account_disabled',
    });
  });
});

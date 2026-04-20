import { describe, expect, test } from 'bun:test';
import { AUTH_PLUGIN_STATE_KEY } from '../../src/authPeer';
import { requireBearer, requireUserAuth } from '../../src/guards';
import { HandlerError, type HandlerMeta } from '../../src/handler';

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
      registerClientSafeEvents() {},
    },
    adapters: {},
    routeAuth: null,
    userResolver: null,
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

function createMeta(overrides: Partial<HandlerMeta> = {}): HandlerMeta {
  return {
    requestId: 'req-1',
    correlationId: 'req-1',
    tenantId: null,
    authUserId: null,
    ip: null,
    authClientId: null,
    bearerClientId: null,
    userAgent: null,
    ...overrides,
  };
}

describe('requireBearer', () => {
  test('allows named bearer clients even when the caller passes identity directly', async () => {
    const guard = requireBearer();

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ bearerClientId: 'svc-static' }),
      } as never),
    ).resolves.toBeUndefined();
  });

  test('rejects invocations without a client identity', async () => {
    const guard = requireBearer();

    await expect(
      guard({
        input: {},
        ctx: createContextFixture() as never,
        meta: createMeta({ authClientId: null, bearerClientId: null }),
      } as never),
    ).rejects.toMatchObject<Partial<HandlerError>>({
      message: 'Unauthorized',
      status: 401,
    });
  });
});

describe('requireUserAuth', () => {
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
        meta: createMeta({ authUserId: 'user-1' }),
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
        meta: createMeta({ authUserId: 'user-1' }),
      } as never),
    ).rejects.toMatchObject<Partial<HandlerError>>({
      message: 'Account disabled',
      status: 403,
      code: 'account_disabled',
    });
  });
});

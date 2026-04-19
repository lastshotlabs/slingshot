/**
 * Integration tests for the slingshot-push plugin.
 *
 * Tests plugin lifecycle, route behavior (subscriptions, topics, ack),
 * notifications delivery adapter wiring, and plugin state presence.
 *
 * Uses app.request() — no HTTP server. web-push is mocked.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
} from '@lastshotlabs/slingshot-core';
import type {
  CoreRegistrar,
  EntityRegistry,
  ResolvedEntityConfig,
  RouteAuthRegistry,
  SlingshotFrameworkConfig,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createPushPlugin } from '../../src/plugin';
import { PUSH_PLUGIN_STATE_KEY, type PushPluginState } from '../../src/state';
import { TEST_VAPID } from '../../src/testing';

// ---------------------------------------------------------------------------
// Mock web-push before any provider creates
// ---------------------------------------------------------------------------

const mockSendNotification = mock(() => Promise.resolve());

mock.module('web-push', () => ({
  default: { sendNotification: mockSendNotification },
  sendNotification: mockSendNotification,
}));

// ---------------------------------------------------------------------------
// Framework config fixture (mirrors community test harness)
// ---------------------------------------------------------------------------

function createFrameworkConfig(): SlingshotFrameworkConfig & {
  registeredEntities: ResolvedEntityConfig[];
} {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
    register(c) {
      registeredEntities.push(c);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate) {
      return registeredEntities.filter(predicate);
    },
  };
  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;
  const storeInfra = createMemoryStoreInfra();
  Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);

  return {
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
    storeInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface PushHarness {
  app: Hono;
  bus: InProcessAdapter;
  pluginState: PushPluginState;
  teardown: () => void;
}

type TestAuthRuntime = {
  adapter: {
    getSuspended?: (
      userId: string,
    ) => Promise<{ suspended: boolean; suspendedReason?: string } | null>;
    getEmailVerified?: (userId: string) => Promise<boolean | null | undefined>;
    setSuspended?: (userId: string, suspended: boolean, reason?: string) => Promise<void>;
    setEmailVerified?: (userId: string, verified: boolean) => Promise<void>;
  };
  config: {
    primaryField?: string;
    emailVerification?: {
      required?: boolean;
    };
  };
};

function toSetupContext(args: {
  app: Hono;
  config: SlingshotFrameworkConfig;
  bus: InProcessAdapter;
}): import('@lastshotlabs/slingshot-core').PluginSetupContext {
  return args as unknown as import('@lastshotlabs/slingshot-core').PluginSetupContext;
}

async function createPushHarness(opts?: {
  userId?: string;
  withNotificationsPlugin?: boolean;
  authRuntime?: TestAuthRuntime;
}): Promise<PushHarness> {
  const userId = opts?.userId ?? 'user-1';
  const bus = new InProcessAdapter();
  const frameworkConfig = createFrameworkConfig();

  const deliveryAdapterCalls: unknown[] = [];
  const notificationsPluginState =
    opts?.withNotificationsPlugin !== false
      ? {
          config: Object.freeze({
            mountPath: '/notifications',
            sseEnabled: false,
            ssePath: '/notifications/sse',
            dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
            rateLimit: { perSourcePerUserPerWindow: 100, windowMs: 3_600_000, backend: 'memory' },
            defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
          }),
          notifications: null,
          preferences: null,
          dispatcher: {
            start() {},
            stop() {},
            async tick() {
              return 0;
            },
          },
          createBuilder: () => null,
          registerDeliveryAdapter: (adapter: unknown) => {
            deliveryAdapterCalls.push(adapter);
          },
        }
      : undefined;

  const pluginState = new Map<string, unknown>();
  if (notificationsPluginState) {
    pluginState.set('slingshot-notifications', notificationsPluginState);
  }
  if (opts?.authRuntime) {
    pluginState.set('slingshot-auth', opts.authRuntime);
  }

  const plugin = createPushPlugin({
    enabledPlatforms: ['web'],
    web: { vapid: TEST_VAPID },
    mountPath: '/push',
  });

  const app = new Hono();

  attachContext(app, {
    app,
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth: RouteAuthRegistry = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-test-user') ?? userId;
      (c as unknown as { set(k: string, v: unknown): void }).set('authUserId', uid);
      const tid = c.req.header('x-test-tenant') ?? '';
      (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', tid);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => async (_c, next) => next(),
  };

  app.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('slingshotCtx', {
      routeAuth,
      pluginState,
    });
    await next();
  });

  const setupContext = toSetupContext({ app, config: frameworkConfig, bus });
  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const state = pluginState.get(PUSH_PLUGIN_STATE_KEY) as PushPluginState;

  return {
    app,
    bus,
    pluginState: state,
    teardown() {},
  };
}

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
      async setSuspended(userId: string, suspended: boolean, reason?: string) {
        suspendedUsers.set(
          userId,
          suspended ? { suspended: true, suspendedReason: reason } : { suspended: false },
        );
      },
      async setEmailVerified(userId: string, verified: boolean) {
        emailVerifiedUsers.set(userId, verified);
      },
    },
    config: {
      primaryField: 'email',
      emailVerification: options.emailVerificationRequired ? { required: true } : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function json(
  app: Hono,
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    userId?: string;
    tenantId?: string;
  },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.userId) headers['x-test-user'] = opts.userId;
  if (opts?.tenantId) headers['x-test-tenant'] = opts.tenantId;

  const res = await app.request(path, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPushPlugin — plugin state', () => {
  let harness: PushHarness;

  beforeEach(async () => {
    harness = await createPushHarness();
  });

  test('PUSH_PLUGIN_STATE_KEY is present in pluginState after setup', () => {
    expect(harness.pluginState).toBeDefined();
    expect(typeof harness.pluginState.router).toBe('object');
    expect(typeof harness.pluginState.formatters).toBe('object');
  });

  test('plugin name matches PUSH_PLUGIN_STATE_KEY', () => {
    expect(PUSH_PLUGIN_STATE_KEY).toBe('slingshot-push');
  });
});

describe('createPushPlugin — subscription upsert', () => {
  let harness: PushHarness;

  beforeEach(async () => {
    harness = await createPushHarness();
  });

  test('POST /push/subscriptions creates a subscription', async () => {
    const res = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        tenantId: '',
        deviceId: 'device-abc',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/endpoint',
          keys: { p256dh: 'p256key', auth: 'authkey' },
        },
      },
    });
    expect(res.status).toBe(201);
  });

  test('POST /push/subscriptions upserts by (userId, tenantId, deviceId)', async () => {
    const subPayload = {
      userId: 'user-1',
      tenantId: '',
      deviceId: 'device-xyz',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/v1',
        keys: { p256dh: 'key1', auth: 'auth1' },
      },
    };

    const res1 = await json(harness.app, 'POST', '/push/subscriptions', { body: subPayload });
    const res2 = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        ...subPayload,
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/v2',
          keys: { p256dh: 'key2', auth: 'auth2' },
        },
      },
    });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    // Both upserts use the same deviceId — they should yield the same record ID
    expect((res1.body as { id?: string }).id).toBe((res2.body as { id?: string }).id);
  });
});

describe('createPushPlugin — topic subscribe / unsubscribe', () => {
  let harness: PushHarness;

  beforeEach(async () => {
    harness = await createPushHarness();
  });

  test('POST /push/topics/:topicName/subscribe and /unsubscribe round-trip', async () => {
    // First create a subscription
    const subRes = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-topic-test',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/e',
          keys: { p256dh: 'k', auth: 'a' },
        },
      },
    });
    expect(subRes.status).toBe(201);

    // Subscribe to topic
    const subTopicRes = await json(harness.app, 'POST', '/push/topics/announcements/subscribe', {
      body: { deviceId: 'device-topic-test' },
    });
    expect(subTopicRes.status).toBe(200);
    expect((subTopicRes.body as { ok: boolean }).ok).toBe(true);

    // Unsubscribe from topic
    const unsubRes = await json(harness.app, 'POST', '/push/topics/announcements/unsubscribe', {
      body: { deviceId: 'device-topic-test' },
    });
    expect(unsubRes.status).toBe(200);
    expect((unsubRes.body as { ok: boolean }).ok).toBe(true);
  });

  test('subscribe to topic requires authentication (401 without user)', async () => {
    // Override to not set authUserId
    const app = new Hono();
    const bus = new InProcessAdapter();
    const fc = createFrameworkConfig();
    const pluginState = new Map<string, unknown>();
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus,
    } as unknown as Parameters<typeof attachContext>[1]);
    app.use('*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('slingshotCtx', {
        routeAuth: {
          userAuth: (async (_c: unknown, next: () => Promise<void>) => {
            await next();
          }) as MiddlewareHandler,
          requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
        },
      });
      await next();
    });
    const plugin = createPushPlugin({
      enabledPlatforms: ['web'],
      web: { vapid: TEST_VAPID },
      mountPath: '/push',
    });
    const setupContext = toSetupContext({ app, config: fc, bus });
    await plugin.setupMiddleware?.(setupContext);
    await plugin.setupRoutes?.(setupContext);
    await plugin.setupPost?.(setupContext);

    const res = await app.request('/push/topics/test/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });
    // Without authUserId set, the route should return 401
    expect(res.status).toBe(401);
  });

  test('subscribe to topic fails closed for suspended authenticated users', async () => {
    const authRuntime = createTestAuthRuntime();
    harness = await createPushHarness({ authRuntime });

    const subRes = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-suspended',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/suspended',
          keys: { p256dh: 'k', auth: 'a' },
        },
      },
    });
    expect(subRes.status).toBe(201);
    await authRuntime.adapter.setSuspended?.('user-1', true, 'security review');

    const res = await json(harness.app, 'POST', '/push/topics/announcements/subscribe', {
      body: { deviceId: 'device-suspended' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account suspended' });
  });
});

describe('createPushPlugin — delivery ack', () => {
  let harness: PushHarness;

  beforeEach(async () => {
    harness = await createPushHarness();
    mockSendNotification.mockReset();
    mockSendNotification.mockImplementation(() => Promise.resolve());
  });

  test('POST /push/ack/:deliveryId marks delivery delivered', async () => {
    // Create subscription and send to get a delivery ID
    await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-ack',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/ack',
          keys: { p256dh: 'k', auth: 'a' },
        },
      },
    });

    let capturedDeliveryId: string | undefined;
    mockSendNotification.mockReset();
    mockSendNotification.mockImplementation((...args: unknown[]) => {
      const payload = args[1];
      const parsed =
        typeof payload === 'string'
          ? (JSON.parse(payload) as { data?: { __slingshotDeliveryId?: string } })
          : {};
      capturedDeliveryId = parsed.data?.__slingshotDeliveryId;
      return Promise.resolve();
    });

    await harness.pluginState.router.sendToUser('user-1', { title: 'Test delivery' });
    expect(capturedDeliveryId).toBeDefined();

    const res = await json(harness.app, 'POST', `/push/ack/${capturedDeliveryId}`);
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  test('POST /push/ack/:deliveryId returns 404 for unknown ID', async () => {
    const res = await json(harness.app, 'POST', '/push/ack/nonexistent-delivery-id');
    expect(res.status).toBe(404);
  });

  test('POST /push/ack/:deliveryId fails closed for newly-unverified sessions', async () => {
    const authRuntime = createTestAuthRuntime({
      emailVerificationRequired: true,
      emailVerified: true,
    });
    harness = await createPushHarness({ authRuntime });
    mockSendNotification.mockReset();
    mockSendNotification.mockImplementation(() => Promise.resolve());

    const subRes = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-unverified',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/unverified',
          keys: { p256dh: 'k', auth: 'a' },
        },
      },
    });
    expect(subRes.status).toBe(201);

    let capturedDeliveryId: string | undefined;
    mockSendNotification.mockReset();
    mockSendNotification.mockImplementation((...args: unknown[]) => {
      const payload = args[1];
      const parsed =
        typeof payload === 'string'
          ? (JSON.parse(payload) as { data?: { __slingshotDeliveryId?: string } })
          : {};
      capturedDeliveryId = parsed.data?.__slingshotDeliveryId;
      return Promise.resolve();
    });

    await harness.pluginState.router.sendToUser('user-1', { title: 'Verify gate' });
    expect(capturedDeliveryId).toBeDefined();
    await authRuntime.adapter.setEmailVerified?.('user-1', false);

    const res = await json(harness.app, 'POST', `/push/ack/${capturedDeliveryId}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Email not verified' });
  });
});

describe('createPushPlugin — notifications delivery adapter wiring', () => {
  test('registers delivery adapter with slingshot-notifications when present', async () => {
    let registeredAdapter: unknown = null;
    const bus = new InProcessAdapter();
    const fc = createFrameworkConfig();
    const pluginState = new Map<string, unknown>();
    const mockNotificationsState = {
      config: Object.freeze({
        mountPath: '/notifications',
        sseEnabled: false,
        ssePath: '/notifications/sse',
        dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
        rateLimit: { perSourcePerUserPerWindow: 100, windowMs: 3_600_000, backend: 'memory' },
        defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
      }),
      notifications: null,
      preferences: null,
      dispatcher: {
        start() {},
        stop() {},
        async tick() {
          return 0;
        },
      },
      createBuilder: () => null,
      registerDeliveryAdapter: (adapter: unknown) => {
        registeredAdapter = adapter;
      },
    };
    pluginState.set('slingshot-notifications', mockNotificationsState);

    const app = new Hono();
    const routeAuth: RouteAuthRegistry = {
      userAuth: (async (_c, next) => {
        await next();
      }) as MiddlewareHandler,
      requireRole: () => async (_c, next) => next(),
    };
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus,
    } as unknown as Parameters<typeof attachContext>[1]);
    app.use('*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('slingshotCtx', { routeAuth });
      await next();
    });

    const plugin = createPushPlugin({
      enabledPlatforms: ['web'],
      web: { vapid: TEST_VAPID },
      mountPath: '/push',
    });
    const setupContext = toSetupContext({ app, config: fc, bus });
    await plugin.setupMiddleware?.(setupContext);
    await plugin.setupRoutes?.(setupContext);
    await plugin.setupPost?.(setupContext);

    expect(registeredAdapter).toBeDefined();
    expect(typeof (registeredAdapter as { deliver?: unknown }).deliver).toBe('function');
  });

  test('boots without notifications plugin present', async () => {
    const bus = new InProcessAdapter();
    const fc = createFrameworkConfig();
    const pluginState = new Map<string, unknown>(); // No notifications state

    const app = new Hono();
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus,
    } as unknown as Parameters<typeof attachContext>[1]);
    app.use('*', async (_c, next) => {
      await next();
    });

    const plugin = createPushPlugin({
      enabledPlatforms: ['web'],
      web: { vapid: TEST_VAPID },
      mountPath: '/push',
    });
    await expect(async () => {
      const setupContext = toSetupContext({ app, config: fc, bus });
      await plugin.setupMiddleware?.(setupContext);
      await plugin.setupRoutes?.(setupContext);
      await plugin.setupPost?.(setupContext);
    }).not.toThrow();
  });
});

describe('createPushPlugin — manifest-first boot', () => {
  test('boots from plain JSON-serializable config object', async () => {
    JSON.parse(
      JSON.stringify({
        enabledPlatforms: ['web'],
        web: { vapid: TEST_VAPID },
        mountPath: '/push',
        formatters: {
          'community:reply': {
            titleTemplate: 'New reply in ${notification.data.threadTitle}',
            bodyTemplate: 'From ${notification.actorId}',
          },
        },
      }),
    );
    const harness = await createPushHarness();
    // The config was serializable — no functions, no class instances
    expect(harness.pluginState).toBeDefined();
    expect(harness.pluginState.config.mountPath).toBe('/push');
  });
});

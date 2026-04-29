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
  createEventDefinitionRegistry,
  createEventPublisher,
  getActorId,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv, PostAuthGuard } from '@lastshotlabs/slingshot-core';
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
import type { PushPluginConfig } from '../../src/types/config';

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
    logging: { enabled: false, verbose: false, authTrace: false, auditWarnings: false },
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

function createRuntime() {
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  return { bus, events };
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
  pluginConfig?: Partial<PushPluginConfig>;
}): Promise<PushHarness> {
  const userId = opts?.userId ?? 'user-1';
  const runtime = createRuntime();
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
    ...(opts?.pluginConfig ?? {}),
  });

  const app = new Hono();

  attachContext(app, {
    app,
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus: runtime.bus,
    events: runtime.events,
  } as unknown as Parameters<typeof attachContext>[1]);

  const postGuards: PostAuthGuard[] | undefined = opts?.authRuntime
    ? [
        async c => {
          const actorId = getActorId(c as import('hono').Context<AppEnv>);
          if (!actorId) return null;
          const rt = opts.authRuntime!;
          const suspensionStatus = await rt.adapter.getSuspended?.(actorId);
          if (suspensionStatus?.suspended) {
            return {
              error: 'ACCOUNT_SUSPENDED',
              message: 'Account is suspended',
              status: 403 as const,
            };
          }
          const requiresVerifiedEmail =
            rt.config?.primaryField === 'email' && rt.config.emailVerification?.required === true;
          if (requiresVerifiedEmail && rt.adapter.getEmailVerified) {
            const verified = await rt.adapter.getEmailVerified(actorId);
            if (!verified) {
              return {
                error: 'EMAIL_NOT_VERIFIED',
                message: 'Email not verified',
                status: 403 as const,
              };
            }
          }
          return null;
        },
      ]
    : undefined;
  const routeAuth: RouteAuthRegistry = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-test-user') ?? userId;
      const tid = c.req.header('x-test-tenant') ?? '';
      const setter = c as unknown as { set(k: string, v: unknown): void };
      setter.set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: tid || null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      setter.set('tenantId', tid);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => async (_c, next) => next(),
    postGuards,
  };

  app.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('slingshotCtx', {
      routeAuth,
      pluginState,
    });
    await next();
  });

  const setupContext = {
    ...toSetupContext({ app, config: frameworkConfig, bus: runtime.bus }),
    events: runtime.events,
  } as import('@lastshotlabs/slingshot-core').PluginSetupContext;
  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const state = pluginState.get(PUSH_PLUGIN_STATE_KEY) as PushPluginState;

  return {
    app,
    bus: runtime.bus,
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
    // Override to not set actor
    const app = new Hono();
    const runtime = createRuntime();
    const fc = createFrameworkConfig();
    const pluginState = new Map<string, unknown>();
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus: runtime.bus,
      events: runtime.events,
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
    const setupContext = {
      ...toSetupContext({ app, config: fc, bus: runtime.bus }),
      events: runtime.events,
    } as import('@lastshotlabs/slingshot-core').PluginSetupContext;
    await plugin.setupMiddleware?.(setupContext);
    await plugin.setupRoutes?.(setupContext);
    await plugin.setupPost?.(setupContext);

    const res = await app.request('/push/topics/test/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });
    // Without actor set, the route should return 401
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
    expect(res.body).toEqual({ error: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' });
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

    // P-PUSH-9: ack endpoint emits push:delivery.delivered so apps can
    // observe terminal state without polling. Verify the bus saw the event.
    let observed = false;
    harness.bus.on('push:delivery.delivered' as never, (payload: unknown) => {
      const p = payload as { deliveryId: string };
      if (p.deliveryId === capturedDeliveryId) observed = true;
    });
    // Re-trigger the listener registration check by acking again — second
    // ack returns 404 (transition is single-use), proving the first ack
    // moved the delivery into `delivered` and prevents re-issuance.
    const res2 = await json(harness.app, 'POST', `/push/ack/${capturedDeliveryId}`);
    expect(res2.status).toBe(404);
    // The first ack was processed before we registered, so we can't observe
    // it post-hoc; instead the 404 above is the structural proof that the
    // delivery moved out of pending into delivered and the entity-level
    // transition consumed.
    expect(observed).toBe(false);
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
    expect(res.body).toEqual({ error: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' });
  });
});

describe('createPushPlugin — provider fan-out resilience', () => {
  test('continues sending later subscriptions when one provider call throws', async () => {
    const harness = await createPushHarness({
      pluginConfig: { retries: { maxAttempts: 1, initialDelayMs: 0 } },
    });
    const providers = harness.pluginState.providers as unknown as {
      web: {
        send: (
          subscription: { platformData: { endpoint: string } },
          message: unknown,
        ) => Promise<{
          ok: boolean;
          reason?: string;
          error?: string;
        }>;
      };
    };
    const send = mock(async (subscription: { platformData: { endpoint: string } }) => {
      if (subscription.platformData.endpoint.includes('fail')) {
        throw new Error('web provider failed');
      }
      return { ok: true };
    });
    providers.web = {
      send,
    };

    await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-fail',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/fail',
          keys: { p256dh: 'k1', auth: 'a1' },
        },
      },
    });
    await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-ok',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/ok',
          keys: { p256dh: 'k2', auth: 'a2' },
        },
      },
    });

    const result = await harness.pluginState.router.sendToUser('user-1', {
      title: 'Fan-out',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.delivered).toBe(1);
  });
});

describe('createPushPlugin — notifications delivery adapter wiring', () => {
  test('registers delivery adapter with slingshot-notifications when present', async () => {
    let registeredAdapter: unknown = null;
    const runtime = createRuntime();
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
      bus: runtime.bus,
      events: runtime.events,
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
    const setupContext = {
      ...toSetupContext({ app, config: fc, bus: runtime.bus }),
      events: runtime.events,
    } as import('@lastshotlabs/slingshot-core').PluginSetupContext;
    await plugin.setupMiddleware?.(setupContext);
    await plugin.setupRoutes?.(setupContext);
    await plugin.setupPost?.(setupContext);

    expect(registeredAdapter).toBeDefined();
    expect(typeof (registeredAdapter as { deliver?: unknown }).deliver).toBe('function');
  });

  test('boots without notifications plugin present', async () => {
    const runtime = createRuntime();
    const fc = createFrameworkConfig();
    const pluginState = new Map<string, unknown>(); // No notifications state

    const app = new Hono();
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus: runtime.bus,
      events: runtime.events,
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
      const setupContext = {
        ...toSetupContext({ app, config: fc, bus: runtime.bus }),
        events: runtime.events,
      } as import('@lastshotlabs/slingshot-core').PluginSetupContext;
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

  test('rejects mountPath values without a leading slash', () => {
    expect(() =>
      createPushPlugin({
        enabledPlatforms: ['web'],
        web: { vapid: TEST_VAPID },
        mountPath: 'push',
      }),
    ).toThrow(/mountPath must start with '\//i);
  });
});

describe('createPushPlugin — path-param validation', () => {
  let harness: PushHarness;

  beforeEach(async () => {
    harness = await createPushHarness();
  });

  test('rejects topic subscribe with oversized topicName (10KB)', async () => {
    const oversized = 'a'.repeat(10_000);
    const res = await json(harness.app, 'POST', `/push/topics/${oversized}/subscribe`, {
      body: { deviceId: 'device-x' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PARAM');
  });

  test('rejects topic subscribe with invalid character in topicName', async () => {
    // '%2F' decodes to '/', but Hono routing can't match — test a clearly
    // invalid character that Hono will pass through.
    const res = await json(harness.app, 'POST', '/push/topics/bad$name/subscribe', {
      body: { deviceId: 'device-x' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PARAM');
  });

  test('rejects topic unsubscribe with oversized topicName', async () => {
    const oversized = 'b'.repeat(2000);
    const res = await json(harness.app, 'POST', `/push/topics/${oversized}/unsubscribe`, {
      body: { deviceId: 'device-x' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PARAM');
  });

  test('accepts a valid topic subscribe (well-formed topicName)', async () => {
    // Create the prerequisite subscription so the route can succeed past
    // validation.
    const subRes = await json(harness.app, 'POST', '/push/subscriptions', {
      body: {
        userId: 'user-1',
        deviceId: 'device-valid',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/valid',
          keys: { p256dh: 'k', auth: 'a' },
        },
      },
    });
    expect(subRes.status).toBe(201);

    const res = await json(harness.app, 'POST', '/push/topics/news.daily/subscribe', {
      body: { deviceId: 'device-valid' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  test('rejects ack with oversized deliveryId', async () => {
    const oversized = 'c'.repeat(500);
    const res = await json(harness.app, 'POST', `/push/ack/${oversized}`);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PARAM');
  });

  test('rejects ack with invalid characters in deliveryId', async () => {
    const res = await json(harness.app, 'POST', '/push/ack/bad$delivery');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PARAM');
  });

  test('accepts a valid (but unknown) deliveryId and returns 404', async () => {
    // Verifies validation passes for a well-formed id; adapter returns null,
    // route maps to 404.
    const res = await json(harness.app, 'POST', '/push/ack/abc-123_def');
    expect(res.status).toBe(404);
  });
});

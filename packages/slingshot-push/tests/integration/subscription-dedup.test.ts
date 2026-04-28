/**
 * Dedup tests for subscription enablement under parallel races.
 *
 * Real users routinely trigger duplicate enablement requests — a service
 * worker registers in two tabs, a mobile app retries an in-flight request,
 * etc. When N parallel `(userId, tenantId, deviceId)` enable calls land at
 * the same time, exactly one subscription row must exist afterwards.
 *
 * The push entities declare unique indexes on `[userId, tenantId, deviceId]`
 * for `PushSubscription` and `[topicId, subscriptionId]` for
 * `PushTopicMembership`. Both rely on `op.upsert` which is documented as
 * atomic on Postgres / SQLite / Mongo but NOT on the in-memory backend
 * (sequential scan + in-place mutation). These tests exercise the route
 * surface with the memory backend the integration harness uses to verify
 * both the contract and the high-level happy path.
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
// web-push mock (any provider import path)
// ---------------------------------------------------------------------------

const mockSendNotification = mock(() => Promise.resolve());

mock.module('web-push', () => ({
  default: { sendNotification: mockSendNotification },
  sendNotification: mockSendNotification,
}));

// ---------------------------------------------------------------------------
// Framework config
// ---------------------------------------------------------------------------

function createFrameworkConfig(): SlingshotFrameworkConfig {
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
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface DedupHarness {
  app: Hono;
  pluginState: PushPluginState;
}

async function createHarness(userId = 'user-1'): Promise<DedupHarness> {
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });

  const frameworkConfig = createFrameworkConfig();
  const pluginState = new Map<string, unknown>();

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
    events,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth: RouteAuthRegistry = {
    userAuth: (async (c, next) => {
      const setter = c as unknown as { set(k: string, v: unknown): void };
      setter.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      setter.set('tenantId', '');
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

  const setupContext = {
    app,
    config: frameworkConfig,
    bus,
    events,
  } as unknown as import('@lastshotlabs/slingshot-core').PluginSetupContext;
  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const state = pluginState.get(PUSH_PLUGIN_STATE_KEY) as PushPluginState;
  return { app, pluginState: state };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PARALLEL_N = 20;

describe('Subscription enablement dedup — parallel POST /push/subscriptions', () => {
  let harness: DedupHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  test('20 parallel upserts for the same (userId, tenantId, deviceId) yield exactly one subscription', async () => {
    const subPayload = {
      userId: 'user-1',
      tenantId: '',
      deviceId: 'device-dedup',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/dedup',
        keys: { p256dh: 'k', auth: 'a' },
      },
    };

    const responses = await Promise.all(
      Array.from({ length: PARALLEL_N }, () =>
        harness.app.request('/push/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(subPayload),
        }),
      ),
    );

    // Each call must return 2xx — no internal errors from the upsert path.
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }

    const ids = await Promise.all(
      responses.map(async r => {
        const body = (await r.json().catch(() => null)) as { id?: string } | null;
        return body?.id;
      }),
    );
    const uniqueIds = new Set(ids.filter(Boolean));

    // The dedup contract: one row, one id, regardless of contention.
    expect(uniqueIds.size).toBe(1);
  });
});

describe('Topic membership dedup — parallel POST /topics/:name/subscribe', () => {
  let harness: DedupHarness;

  beforeEach(async () => {
    harness = await createHarness();
    // Seed the underlying subscription once.
    const subRes = await harness.app.request('/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-1',
        tenantId: '',
        deviceId: 'device-topic-dedup',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/topic-dedup',
          keys: { p256dh: 'k', auth: 'a' },
        },
      }),
    });
    expect(subRes.status).toBe(201);
  });

  test('20 parallel topic subscribes for the same (topicId, subscriptionId) yield exactly one membership', async () => {
    const responses = await Promise.all(
      Array.from({ length: PARALLEL_N }, () =>
        harness.app.request('/push/topics/announcements/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: 'device-topic-dedup' }),
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Verify exactly one membership exists by publishing — duplicate
    // memberships would surface as duplicate deliveries to the same sub.
    const sendCounts = new Map<string, number>();
    const originalSend = harness.pluginState.providers.web!.send.bind(
      harness.pluginState.providers.web!,
    );
    harness.pluginState.providers.web!.send = async (sub, msg, ctx) => {
      sendCounts.set(sub.id, (sendCounts.get(sub.id) ?? 0) + 1);
      return originalSend(sub, msg, ctx);
    };

    const result = await harness.pluginState.router.publishTopic('announcements', {
      title: 'Dedup check',
    });

    // Exactly one subscription, one delivery, one provider send.
    expect(result.delivered).toBe(1);
    expect(sendCounts.size).toBe(1);
    for (const c of sendCounts.values()) {
      expect(c).toBe(1);
    }
  });
});

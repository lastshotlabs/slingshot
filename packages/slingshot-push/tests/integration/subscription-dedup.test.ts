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
  getContextOrNull,
  registerPluginCapabilities,
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
import { createEntityFactories, createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { PushDelivery } from '../../src/entities/pushDelivery';
import { PushSubscription } from '../../src/entities/pushSubscription';
import { PushTopic } from '../../src/entities/pushTopic';
import { PushTopicMembership } from '../../src/entities/pushTopicMembership';
import {
  pushDeliveryFactories,
  pushSubscriptionFactories,
  pushTopicFactories,
  pushTopicMembershipFactories,
} from '../../src/entities/factories';
import { pushDeliveryOperations } from '../../src/entities/pushDelivery';
import { pushSubscriptionOperations } from '../../src/entities/pushSubscription';
import { pushTopicOperations } from '../../src/entities/pushTopic';
import { pushTopicMembershipOperations } from '../../src/entities/pushTopicMembership';
import { createPushPackage } from '../../src/plugin';
import { type PushPluginState } from '../../src/state';
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

  const plugin = createPushPackage({
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

  // Manual entity-route mounting that bypasses createApp/compilePackages.
  // Delegate adapter construction to each entity module's own wiring so the
  // package's onAdapter / manual-wiring buildAdapter closures all fire and
  // the entity routes share state with the package's internal refs.
  function buildAdapterForEntity(
    entityName: string,
  ): EntityPluginEntry['buildAdapter'] {
    const entityModule = plugin.entities.find(e => e.entityName === entityName);
    if (!entityModule) throw new Error(`entity ${entityName} not found on plugin`);
    const impl = (entityModule as { implementation: unknown }).implementation as {
      wiring: {
        mode: string;
        buildAdapter?: EntityPluginEntry['buildAdapter'];
        factories?: unknown;
        onAdapter?: (a: BareEntityAdapter) => void;
      };
    };
    const wiring = impl.wiring;
    if (wiring.mode === 'manual' && wiring.buildAdapter) {
      return wiring.buildAdapter;
    }
    if (wiring.mode === 'factories' && wiring.factories) {
      const factories = wiring.factories as Record<string, (infra: never) => BareEntityAdapter>;
      return (storeType, infra) => {
        const adapter = factories[storeType](infra as never);
        wiring.onAdapter?.(adapter);
        return adapter;
      };
    }
    throw new Error(`unsupported wiring mode for ${entityName}: ${wiring.mode}`);
  }

  const entityEntries: EntityPluginEntry[] = [
    {
      config: PushSubscription,
      operations: pushSubscriptionOperations.operations,
      routePath: 'subscriptions',
      buildAdapter: buildAdapterForEntity('PushSubscription'),
    },
    {
      config: PushTopic,
      operations: pushTopicOperations.operations,
      buildAdapter: buildAdapterForEntity('PushTopic'),
    },
    {
      config: PushTopicMembership,
      operations: pushTopicMembershipOperations.operations,
      buildAdapter: buildAdapterForEntity('PushTopicMembership'),
    },
    {
      config: PushDelivery,
      operations: pushDeliveryOperations.operations,
      routePath: 'deliveries',
      buildAdapter: buildAdapterForEntity('PushDelivery'),
    },
  ];
  const entityPlugin = createEntityPlugin({
    name: 'slingshot-push',
    mountPath: plugin.mountPath ?? '/push',
    entities: entityEntries,
  });

  await plugin.setupMiddleware?.(setupContext);
  await entityPlugin.setupMiddleware?.(setupContext);
  await entityPlugin.setupRoutes?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await entityPlugin.setupPost?.(setupContext);
  await plugin.setupPost?.(setupContext);

  // Drive the declarative capabilities slot the same way compilePackages
  // would at framework boot, since this test bypasses createApp.
  const slingshotCtx = getContextOrNull(app);
  if (slingshotCtx) {
    await registerPluginCapabilities(
      slingshotCtx as never,
      plugin.name,
      plugin.capabilities.provides,
    );
  }

  const slot = pluginState.get('slingshot:package:capabilities:slingshot-push') as
    | { runtime?: PushPluginState }
    | undefined;
  const state = slot?.runtime as PushPluginState;
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

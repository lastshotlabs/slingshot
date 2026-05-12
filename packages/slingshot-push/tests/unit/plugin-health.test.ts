import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  getContext,
  registerPluginCapabilities,
  resolveCapabilityValue,
} from '@lastshotlabs/slingshot-core';
import type { SlingshotFrameworkConfig, StoreType } from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import {
  createEntityFactories,
  createEntityPlugin,
} from '@lastshotlabs/slingshot-entity';
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
import { PushHealthCap } from '../../src/public';

describe('createPushPackage health capability', () => {
  test('PushHealthCap exposes a healthy snapshot after setupPost wires providers', async () => {
    const pkg = createPushPackage({
      enabledPlatforms: ['android'],
      mountPath: '/push',
      android: {
        serviceAccount: {
          project_id: 'test-project',
          client_email: 'firebase@test.iam.gserviceaccount.com',
          // Stub credential — the Android provider is built lazily and we
          // never actually contact Google here. Health reads the provider's
          // in-memory breaker state, which starts in `closed`.
          private_key: 'k',
        },
      },
    });

    const app = new Hono();
    const bus = new InProcessAdapter();
    const events = createEventPublisher({
      definitions: createEventDefinitionRegistry(),
      bus,
    });
    const storeInfra = createMemoryStoreInfra();
    Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);
    const frameworkConfig = {
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
      registrar: { registerRouteAuth() {}, build: () => ({}) } as never,
      entityRegistry: { register() {}, getAll: () => [], filter: () => [] } as never,
      password: Bun.password,
    } as unknown as SlingshotFrameworkConfig;

    const pluginState = new Map<string, unknown>();
    const capabilityProviders = new Map<string, string>();
    attachContext(app, {
      app,
      pluginState,
      capabilityProviders,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus,
      events,
    } as never);

    // Mount entity routes manually since this test bypasses createApp().
    // Delegate adapter construction to each entity module's own wiring so the
    // package's adapter-ref closures fire as they would under the framework path.
    function buildAdapterForEntity(
      entityName: string,
    ): EntityPluginEntry['buildAdapter'] {
      const entityModule = pkg.entities.find(e => e.entityName === entityName);
      if (!entityModule) throw new Error(`entity ${entityName} not found on pkg`);
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
      mountPath: '/push',
      entities: entityEntries,
    });

    const ctx = { app, config: frameworkConfig, bus, events } as never;
    await pkg.setupMiddleware?.(ctx);
    await entityPlugin.setupMiddleware?.(ctx);
    await entityPlugin.setupRoutes?.(ctx);
    await pkg.setupRoutes?.(ctx);
    await entityPlugin.setupPost?.(ctx);
    await pkg.setupPost?.(ctx);

    // Drive the declarative capabilities slot the same way compilePackages
    // does at framework boot.
    await registerPluginCapabilities(
      getContext(app) as never,
      pkg.name,
      pkg.capabilities.provides,
    );

    const getHealth = resolveCapabilityValue(getContext(app), PushHealthCap);
    expect(typeof getHealth).toBe('function');
    const health = getHealth!();
    expect(health.status).toBe('healthy');
    expect(Object.keys(health.details.providers)).toContain('android');
  });
});

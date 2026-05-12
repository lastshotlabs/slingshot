import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  MetricsEmitter,
  PluginSetupContext,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  createNoopMetricsEmitter,
  deepFreeze,
  definePackage,
  getActorId,
  getActorTenantId,
  getContextOrNull,
  provideCapability,
  resolveCapabilityValue,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { NotificationsDeliveryRegistry } from '@lastshotlabs/slingshot-notifications';
import { PushHealthCap, PushRuntimeCap } from './public';
import type { PushPluginHealth } from './public';
import type { RouteAuthRegistry } from '@lastshotlabs/slingshot-core';
import { createPushDeliveryAdapter } from './deliveryAdapter';
import { buildPushEntityModules } from './entities/modules';
import { compilePushFormatters } from './formatter';
import { ApnsTokenAuth, createApnsProvider } from './providers/apns';
import { createFcmProvider } from './providers/fcm';
import type { PushProvider } from './providers/provider';
import { createWebPushProvider } from './providers/web';
import { type PushRouterRepos, createPushRouter } from './router';
import { type PushPluginState } from './state';
import {
  type FirebaseServiceAccount,
  type PushPluginConfig,
  pushPluginConfigSchema,
} from './types/config';

// Path-param validators for the push HTTP surface.
const topicNameParamSchema = z
  .string()
  .min(1, 'topicName is required')
  .max(256, 'topicName must be at most 256 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'topicName contains invalid characters');

const deliveryIdParamSchema = z
  .string()
  .min(1, 'deliveryId is required')
  .max(128, 'deliveryId must be at most 128 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'deliveryId contains invalid characters');

function parseServiceAccount(value: FirebaseServiceAccount | string): FirebaseServiceAccount {
  if (typeof value !== 'string') return value;
  try {
    if (value.startsWith('file://')) {
      return JSON.parse(readFileSync(new URL(value), 'utf8')) as FirebaseServiceAccount;
    }
    return JSON.parse(value) as FirebaseServiceAccount;
  } catch (err) {
    throw new Error(
      `[slingshot-push] Failed to parse Firebase service account: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Create the multi-provider push package.
 *
 * Validates `rawConfig` via `pushPluginConfigSchema`, mounts the four push
 * entities (subscriptions, topics, topic memberships, deliveries) through the
 * declarative package authoring path, wires Web Push / APNS / FCM providers,
 * mounts the bespoke topic-subscribe / unsubscribe / ack routes, and registers
 * a delivery adapter with `slingshot-notifications` when present.
 *
 * Cross-package consumers resolve the runtime via `PushRuntimeCap` and the
 * aggregated health snapshot via `PushHealthCap`.
 *
 * @param rawConfig - Package config. Validated against `pushPluginConfigSchema`.
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 */
export function createPushPackage(rawConfig: PushPluginConfig): SlingshotPackageDefinition {
  const config = deepFreeze(
    validatePluginConfig('slingshot-push', rawConfig, pushPluginConfigSchema),
  );
  const enabledPlatforms = new Set(config.enabledPlatforms);

  // Closure-owned adapter refs populated by the entity modules' `onAdapter`
  // callbacks during bootstrap. Sharing a single adapter instance per entity
  // between the entity routes and the package's imperative router/route work
  // is critical for memory-store correctness.
  let subscriptionsRef: PushRouterRepos['subscriptions'] | undefined;
  let topicsRef: PushRouterRepos['topics'] | undefined;
  let membershipsRef: PushRouterRepos['topicMemberships'] | undefined;
  let deliveriesRef: PushRouterRepos['deliveries'] | undefined;
  let providersRef: Partial<Record<'web' | 'ios' | 'android', PushProvider>> = {};
  // Captured during setupPost so teardown can abort in-flight retry sleeps.
  let routerRef: ReturnType<typeof createPushRouter> | null = null;
  // Hoisted ref read by the declarative `PushRuntimeCap` resolver. Populated
  // in setupPost; resolver throws a clear "not ready" error when read earlier.
  let runtimeStateRef: PushPluginState | undefined;

  // The unified metrics emitter is owned by the framework context and not
  // available until `setupPost` runs (the router is constructed there). We
  // resolve it lazily via the indirection below so callers that capture the
  // proxy ahead of time still see the framework-owned emitter at call time.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  const {
    pushSubscriptionModule,
    pushTopicModule,
    pushTopicMembershipModule,
    pushDeliveryModule,
  } = buildPushEntityModules({
    onSubscriptions: adapter => {
      subscriptionsRef = adapter as unknown as PushRouterRepos['subscriptions'];
    },
    onTopics: adapter => {
      topicsRef = adapter as unknown as PushRouterRepos['topics'];
    },
    onTopicMemberships: adapter => {
      membershipsRef = adapter as unknown as PushRouterRepos['topicMemberships'];
    },
    onDeliveries: adapter => {
      deliveriesRef = adapter as unknown as PushRouterRepos['deliveries'];
    },
  });

  function getHealth(): PushPluginHealth {
    const providers: Partial<
      Record<'web' | 'ios' | 'android', PushPluginHealth['details']['providers']['web']>
    > = {};
    let worst: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    for (const platform of ['web', 'ios', 'android'] as const) {
      const provider = providersRef[platform];
      if (!provider) continue;
      const snapshot = provider.getHealth?.() ?? null;
      providers[platform] = snapshot;
      if (!snapshot) continue;
      if (snapshot.circuitState === 'open') {
        worst = 'unhealthy';
      } else if (worst !== 'unhealthy') {
        if (snapshot.circuitState === 'half-open' || snapshot.consecutiveFailures > 0) {
          worst = 'degraded';
        }
      }
    }

    let routerCircuitBreaker: PushPluginHealth['details']['routerCircuitBreaker'] | undefined;
    if (routerRef) {
      const breakerHealth = routerRef.getBreakerHealth?.();
      if (breakerHealth) {
        routerCircuitBreaker = {
          state: breakerHealth.circuitState,
          consecutiveFailures: breakerHealth.consecutiveFailures,
        };
        if (breakerHealth.circuitState === 'open') {
          worst = 'unhealthy';
        } else if (worst !== 'unhealthy' && breakerHealth.circuitState === 'half-open') {
          worst = 'degraded';
        }
      }
    }

    return { status: worst, details: { providers, routerCircuitBreaker } };
  }

  return definePackage({
    name: 'slingshot-push',
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    entities: [
      pushSubscriptionModule,
      pushTopicModule,
      pushTopicMembershipModule,
      pushDeliveryModule,
    ],
    publicPaths: enabledPlatforms.has('web') ? [`${config.mountPath}/vapid-public-key`] : [],
    csrfExemptPaths: [`${config.mountPath}/*`],
    capabilities: {
      provides: [
        provideCapability(PushRuntimeCap, () => {
          if (!runtimeStateRef) {
            throw new Error(
              '[slingshot-push] runtime requested before setupPost completed; consumers must read PushRuntimeCap from setupPost or later.',
            );
          }
          return runtimeStateRef;
        }),
        provideCapability(PushHealthCap, () => getHealth),
      ],
    },

    setupRoutes({ app, bus }: PluginSetupContext) {
      const requireUserAuth: MiddlewareHandler = async (c, next) => {
        const slingshotCtx = c.get('slingshotCtx') as { routeAuth?: RouteAuthRegistry } | undefined;
        const routeAuth = slingshotCtx?.routeAuth;
        if (!routeAuth?.userAuth) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return routeAuth.userAuth(c, async () => {
          const userId = getActorId(c);
          if (!userId) {
            c.res = c.json({ error: 'Unauthorized' }, 401);
            return;
          }
          if (routeAuth.postGuards) {
            for (const guard of routeAuth.postGuards) {
              const failure = await guard(c);
              if (failure) {
                c.res = c.json({ error: failure.error, message: failure.message }, failure.status);
                return;
              }
            }
          }
          await next();
        });
      };

      app.post(`${config.mountPath}/topics/:topicName/subscribe`, requireUserAuth, async c => {
        const userId = getActorId(c);
        if (!userId || !subscriptionsRef || !topicsRef || !membershipsRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const tenantId = getActorTenantId(c) ?? '';
        const body = (await c.req.json().catch(() => null)) as { deviceId?: string } | null;
        if (!body?.deviceId) return c.json({ error: 'deviceId is required' }, 400);

        const topicNameResult = topicNameParamSchema.safeParse(c.req.param('topicName'));
        if (!topicNameResult.success) {
          return c.json(
            {
              error: 'INVALID_PARAM',
              message: topicNameResult.error.issues[0]?.message ?? 'invalid topicName',
            },
            400,
          );
        }
        const topicName = topicNameResult.data;
        const topic = await topicsRef.ensureByName({
          tenantId,
          name: topicName,
        });
        const subscription = await subscriptionsRef.findByDevice({
          userId,
          tenantId,
          deviceId: body.deviceId,
        });
        if (!subscription) return c.json({ error: 'subscription not found' }, 404);

        await membershipsRef.ensureMembership({
          topicId: topic.id,
          subscriptionId: subscription.id,
          userId,
          tenantId,
        });
        return c.json({ ok: true }, 200);
      });

      app.post(`${config.mountPath}/topics/:topicName/unsubscribe`, requireUserAuth, async c => {
        const userId = getActorId(c);
        if (!userId || !subscriptionsRef || !topicsRef || !membershipsRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const tenantId = getActorTenantId(c) ?? '';
        const body = (await c.req.json().catch(() => null)) as { deviceId?: string } | null;
        if (!body?.deviceId) return c.json({ error: 'deviceId is required' }, 400);

        const topicNameResult = topicNameParamSchema.safeParse(c.req.param('topicName'));
        if (!topicNameResult.success) {
          return c.json(
            {
              error: 'INVALID_PARAM',
              message: topicNameResult.error.issues[0]?.message ?? 'invalid topicName',
            },
            400,
          );
        }
        const topic = await topicsRef.findByName({
          tenantId,
          name: topicNameResult.data,
        });
        if (!topic) return c.json({ ok: true }, 200);

        const subscription = await subscriptionsRef.findByDevice({
          userId,
          tenantId,
          deviceId: body.deviceId,
        });
        if (!subscription) return c.json({ ok: true }, 200);

        await membershipsRef.removeByTopicAndSub({
          topicId: topic.id,
          subscriptionId: subscription.id,
        });
        return c.json({ ok: true }, 200);
      });

      app.post(`${config.mountPath}/ack/:deliveryId`, requireUserAuth, async c => {
        const userId = getActorId(c);
        if (!userId || !deliveriesRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const deliveryIdResult = deliveryIdParamSchema.safeParse(c.req.param('deliveryId'));
        if (!deliveryIdResult.success) {
          return c.json(
            {
              error: 'INVALID_PARAM',
              message: deliveryIdResult.error.issues[0]?.message ?? 'invalid deliveryId',
            },
            400,
          );
        }
        const deliveryId = deliveryIdResult.data;
        const delivery = await deliveriesRef.markDelivered({ id: deliveryId, 'actor.id': userId });
        if (!delivery) return c.json({ error: 'Not found' }, 404);

        if (subscriptionsRef) {
          await subscriptionsRef.touchLastSeen(
            { id: delivery.subscriptionId },
            {
              lastSeenAt: new Date(),
            },
          );
        }
        (bus as { emit(event: string, payload: unknown): void }).emit('push:delivery.delivered', {
          deliveryId: delivery.id,
          subscriptionId: delivery.subscriptionId,
          userId: delivery.userId,
        });
        return c.json({ ok: true }, 200);
      });

      if (enabledPlatforms.has('web') && config.web) {
        app.get(`${config.mountPath}/vapid-public-key`, c =>
          c.json({ publicKey: config.web?.vapid.publicKey ?? '' }, 200),
        );
      }
    },

    async setupPost({ app, bus }: PluginSetupContext) {
      // Resolve the framework-owned metrics emitter so the router publishes
      // counters/gauges/timings on hot paths. Test harnesses may attach a
      // context without a metricsEmitter — keep the default no-op then.
      const ctx = getContextOrNull(app);
      if (ctx?.metricsEmitter) resolvedMetricsEmitter = ctx.metricsEmitter;

      (
        bus as {
          registerForbiddenClientSafePrefix?(prefix: string): void;
        }
      ).registerForbiddenClientSafePrefix?.('push:');

      if (!subscriptionsRef || !topicsRef || !membershipsRef || !deliveriesRef) {
        throw new Error(
          '[slingshot-push] Push entity adapters were not resolved during bootstrap',
        );
      }

      const providers: Partial<Record<'web' | 'ios' | 'android', PushProvider>> = {};
      if (enabledPlatforms.has('web') && config.web) {
        providers.web = createWebPushProvider({ vapid: config.web.vapid });
      }
      if (enabledPlatforms.has('ios') && config.ios) {
        providers.ios = createApnsProvider({
          auth: new ApnsTokenAuth(config.ios.auth),
          defaultBundleId: config.ios.defaultBundleId,
          defaultEnvironment: config.ios.defaultEnvironment,
        });
      }
      if (enabledPlatforms.has('android') && config.android) {
        providers.android = createFcmProvider({
          serviceAccount: parseServiceAccount(config.android.serviceAccount),
        });
      }
      providersRef = providers;

      const router = createPushRouter({
        providers,
        repos: {
          subscriptions: subscriptionsRef,
          topics: topicsRef,
          topicMemberships: membershipsRef,
          deliveries: deliveriesRef,
        },
        retries: config.retries,
        bus: bus as { emit(event: string, payload: unknown): void },
        metrics: metricsProxy,
        ...(config.providerTimeoutMs !== undefined
          ? { providerTimeoutMs: config.providerTimeoutMs }
          : {}),
        ...(config.topicMaxRecipients !== undefined
          ? { topicMaxRecipients: config.topicMaxRecipients }
          : {}),
      });
      routerRef = router;
      const formatters = compilePushFormatters(config.formatters ?? {});

      const state: PushPluginState = {
        config,
        router,
        providers,
        formatters,
        registerFormatter(type, formatter) {
          formatters.register(type, formatter);
        },
        createDeliveryAdapter(opts = {}) {
          return createPushDeliveryAdapter({
            router,
            formatters,
            skipSources: opts.skipSources,
            defaults: config.notifications,
          });
        },
      };

      // Capability publication is declarative on the package — see
      // `definePackage({ capabilities: { provides: [...] } })` above. We just
      // populate the hoisted ref so resolvers stop throwing.
      runtimeStateRef = state;

      // Consume the slingshot-notifications contract: register our delivery adapter
      // through the typed `NotificationsDeliveryRegistry` capability when notifications
      // is loaded. No-op when notifications isn't installed at all.
      const slingshotCtx = getContextOrNull(app);
      const deliveryRegistry = slingshotCtx
        ? resolveCapabilityValue(slingshotCtx, NotificationsDeliveryRegistry)
        : undefined;
      if (deliveryRegistry) {
        deliveryRegistry.register(state.createDeliveryAdapter());
      }
    },

    teardown(): void {
      // P-PUSH-6: abort in-flight retry sleeps so a graceful shutdown unwinds
      // promptly instead of running attempts past teardown.
      if (routerRef) {
        try {
          routerRef.stop();
        } catch {
          // Stop must never throw during teardown.
        }
        routerRef = null;
      }
    },
  });
}

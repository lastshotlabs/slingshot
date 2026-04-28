import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  MetricsEmitter,
  PluginSetupContext,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  createNoopMetricsEmitter,
  deepFreeze,
  getActorId,
  getActorTenantId,
  getContextOrNull,
  getNotificationsStateOrNull,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { RouteAuthRegistry } from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { createPushDeliveryAdapter } from './deliveryAdapter';
import { compilePushFormatters } from './formatter';
import { pushManifest } from './manifest/pushManifest';
import { createPushManifestRuntime } from './manifest/runtime';
import { ApnsTokenAuth, createApnsProvider } from './providers/apns';
import { createFcmProvider } from './providers/fcm';
import type { PushProvider, PushProviderHealth } from './providers/provider';
import { createWebPushProvider } from './providers/web';
import { type PushRouterRepos, createPushRouter } from './router';
import { PUSH_PLUGIN_STATE_KEY, type PushPluginState } from './state';
import {
  type FirebaseServiceAccount,
  type PushPluginConfig,
  pushPluginConfigSchema,
} from './types/config';

/**
 * Aggregated health snapshot for `slingshot-push`. Returned by the
 * `getHealth()` method attached to the plugin instance.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when any provider's circuit breaker is `open`.
 *   - `'degraded'` when any provider's circuit breaker is `half-open` or any
 *     provider has accumulated `consecutiveFailures > 0`.
 *   - `'healthy'` otherwise.
 */
export interface PushPluginHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /**
     * Per-platform provider health snapshots. Missing platforms are not
     * enabled. Built-in providers (web / APNS / FCM) all implement
     * `getHealth()`, so when a platform is enabled and its provider has been
     * resolved (post `setupPost`) the value is always a snapshot — never
     * `null`. The `| null` branch remains for forward-compatibility with
     * custom providers that omit `getHealth()`.
     */
    readonly providers: Readonly<
      Partial<Record<'web' | 'ios' | 'android', PushProviderHealth | null>>
    >;
  };
}

/**
 * Path-param validators for the push HTTP surface.
 *
 * Topic names are user-visible identifiers — we accept letters, digits, and a
 * small set of separators (`-`, `_`, `:`, `.`) within a 1..256-char window.
 * Delivery IDs are persisted entity ids (UUIDs by default) — we keep the
 * character set conservative but accept any non-UUID value within bounds so
 * adapters that mint custom ids continue to work; oversized or empty inputs
 * are rejected before they reach the adapter layer.
 */
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
 * Create the multi-provider push plugin.
 *
 * Validates `rawConfig` via `pushPluginConfigSchema`, registers push entities
 * (subscriptions, topics, topic memberships, deliveries), mounts push routes,
 * wires Web Push / APNS / FCM providers, and registers a delivery adapter with
 * `slingshot-notifications` when that plugin is present.
 *
 * @param rawConfig - Manifest-safe push plugin config. Validated against
 *   `pushPluginConfigSchema`.
 * @returns A Slingshot plugin that registers push entities, routes, providers,
 *   router state, and optional notifications delivery wiring.
 *
 * @example
 * ```ts
 * import { createPushPlugin } from '@lastshotlabs/slingshot-push';
 *
 * const plugin = createPushPlugin({
 *   enabledPlatforms: ['web', 'ios', 'android'],
 *   mountPath: '/push',
 *   web: { vapid: { publicKey: '...', privateKey: '...', subject: 'mailto:push@example.com' } },
 *   ios: { auth: { kind: 'p8-token', keyPem: '...', keyId: 'ABC123', teamId: 'TEAM123456' } },
 *   android: { serviceAccount: { project_id: 'my-project', client_email: '...', private_key: '...' } },
 *   notifications: { icon: '/icon-192.png', badge: '/badge-72.png', defaultUrl: '/' },
 *   retries: { maxAttempts: 3, initialDelayMs: 1000 },
 * });
 * ```
 */
export function createPushPlugin(
  rawConfig: PushPluginConfig,
): SlingshotPlugin & { getHealth(): PushPluginHealth } {
  const config = deepFreeze(
    validatePluginConfig('slingshot-push', rawConfig, pushPluginConfigSchema),
  );
  const enabledPlatforms = new Set(config.enabledPlatforms);

  let innerPlugin: EntityPlugin | undefined;
  let subscriptionsRef: PushRouterRepos['subscriptions'] | undefined;
  let topicsRef: PushRouterRepos['topics'] | undefined;
  let membershipsRef: PushRouterRepos['topicMemberships'] | undefined;
  let deliveriesRef: PushRouterRepos['deliveries'] | undefined;
  let providersRef: Partial<Record<'web' | 'ios' | 'android', PushProvider>> = {};
  // Captured during setupPost so teardown can abort in-flight retry sleeps.
  let routerRef: ReturnType<typeof createPushRouter> | null = null;

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
  const manifestRuntime = createPushManifestRuntime(adapters => {
    subscriptionsRef = adapters.subscriptions;
    topicsRef = adapters.topics;
    membershipsRef = adapters.topicMemberships;
    deliveriesRef = adapters.deliveries;
  });

  function getHealth(): PushPluginHealth {
    const providers: Partial<Record<'web' | 'ios' | 'android', PushProviderHealth | null>> = {};
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
    return { status: worst, details: { providers } };
  }

  return {
    name: PUSH_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth'],
    publicPaths: enabledPlatforms.has('web') ? [`${config.mountPath}/vapid-public-key`] : [],
    csrfExemptPaths: [`${config.mountPath}/*`],
    getHealth,

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      innerPlugin = createEntityPlugin({
        name: PUSH_PLUGIN_STATE_KEY,
        mountPath: config.mountPath,
        manifest: pushManifest,
        manifestRuntime,
      });

      await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus, events });
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

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

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      // Resolve the framework-owned metrics emitter so the router publishes
      // counters/gauges/timings on hot paths. The proxy above ensures the
      // router constructed below sees this emitter without re-wiring. Test
      // harnesses may attach a context without a metricsEmitter — keep the
      // default no-op in that case.
      const ctx = getContextOrNull(app);
      if (ctx?.metricsEmitter) resolvedMetricsEmitter = ctx.metricsEmitter;

      (
        bus as {
          registerForbiddenClientSafePrefix?(prefix: string): void;
        }
      ).registerForbiddenClientSafePrefix?.('push:');

      if (!subscriptionsRef || !topicsRef || !membershipsRef || !deliveriesRef) {
        throw new Error(
          '[slingshot-push] Push entity adapters were not resolved during setupRoutes',
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
      // Capture the resolved providers so the plugin's getHealth() method can
      // surface per-provider circuit-breaker / failure-count snapshots.
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

      const pluginState = getPluginState(app);
      pluginState.set(PUSH_PLUGIN_STATE_KEY, state);

      const notificationsState = getNotificationsStateOrNull(pluginState);
      if (notificationsState) {
        notificationsState.registerDeliveryAdapter(state.createDeliveryAdapter());
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
  };
}

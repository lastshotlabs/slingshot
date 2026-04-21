import { readFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getNotificationsStateOrNull,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { createPushDeliveryAdapter } from './deliveryAdapter';
import { compilePushFormatters } from './formatter';
import { pushManifest } from './manifest/pushManifest';
import { createPushManifestRuntime } from './manifest/runtime';
import { ApnsTokenAuth, createApnsProvider } from './providers/apns';
import { createFcmProvider } from './providers/fcm';
import type { PushProvider } from './providers/provider';
import { createWebPushProvider } from './providers/web';
import { type PushRouterRepos, createPushRouter } from './router';
import { PUSH_PLUGIN_STATE_KEY, type PushPluginState } from './state';
import {
  type FirebaseServiceAccount,
  type PushPluginConfig,
  pushPluginConfigSchema,
} from './types/config';
import { getUserAuthAccountGuardFailure } from './userAuthAccountGuard';

function parseServiceAccount(value: FirebaseServiceAccount | string): FirebaseServiceAccount {
  if (typeof value !== 'string') return value;
  if (value.startsWith('file://')) {
    return JSON.parse(readFileSync(new URL(value), 'utf8')) as FirebaseServiceAccount;
  }
  return JSON.parse(value) as FirebaseServiceAccount;
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
export function createPushPlugin(rawConfig: PushPluginConfig): SlingshotPlugin {
  const config = deepFreeze(
    validatePluginConfig('slingshot-push', rawConfig, pushPluginConfigSchema),
  );
  const enabledPlatforms = new Set(config.enabledPlatforms);

  let innerPlugin: EntityPlugin | undefined;
  let subscriptionsRef: PushRouterRepos['subscriptions'] | undefined;
  let topicsRef: PushRouterRepos['topics'] | undefined;
  let membershipsRef: PushRouterRepos['topicMemberships'] | undefined;
  let deliveriesRef: PushRouterRepos['deliveries'] | undefined;
  const manifestRuntime = createPushManifestRuntime(adapters => {
    subscriptionsRef = adapters.subscriptions;
    topicsRef = adapters.topics;
    membershipsRef = adapters.topicMemberships;
    deliveriesRef = adapters.deliveries;
  });

  return {
    name: PUSH_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth'],
    publicPaths: enabledPlatforms.has('web') ? [`${config.mountPath}/vapid-public-key`] : [],
    csrfExemptPaths: [`${config.mountPath}/*`],

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
        const slingshotCtx = c.get('slingshotCtx') as
          | { routeAuth?: { userAuth?: MiddlewareHandler } }
          | undefined;
        const userAuth = slingshotCtx?.routeAuth?.userAuth;
        if (!userAuth) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return userAuth(c, async () => {
          const authUserId = c.get('authUserId');
          if (typeof authUserId !== 'string' || authUserId.length === 0) {
            c.res = c.json({ error: 'Unauthorized' }, 401);
            return;
          }
          const guardFailure = await getUserAuthAccountGuardFailure(c);
          if (guardFailure) {
            c.res = c.json({ error: guardFailure.error }, guardFailure.status);
            return;
          }
          await next();
        });
      };

      app.post(`${config.mountPath}/topics/:topicName/subscribe`, requireUserAuth, async c => {
        const authUserId = c.get('authUserId');
        if (typeof authUserId !== 'string' || !subscriptionsRef || !topicsRef || !membershipsRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const tenantId = (c.get('tenantId') as string | undefined) ?? '';
        const body = (await c.req.json().catch(() => null)) as { deviceId?: string } | null;
        if (!body?.deviceId) return c.json({ error: 'deviceId is required' }, 400);

        const topicName = c.req.param('topicName');
        const topic = await topicsRef.ensureByName({
          tenantId,
          name: topicName,
        });
        const subscription = await subscriptionsRef.findByDevice({
          userId: authUserId,
          tenantId,
          deviceId: body.deviceId,
        });
        if (!subscription) return c.json({ error: 'subscription not found' }, 404);

        await membershipsRef.ensureMembership({
          topicId: topic.id,
          subscriptionId: subscription.id,
          userId: authUserId,
          tenantId,
        });
        return c.json({ ok: true }, 200);
      });

      app.post(`${config.mountPath}/topics/:topicName/unsubscribe`, requireUserAuth, async c => {
        const authUserId = c.get('authUserId');
        if (typeof authUserId !== 'string' || !subscriptionsRef || !topicsRef || !membershipsRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const tenantId = (c.get('tenantId') as string | undefined) ?? '';
        const body = (await c.req.json().catch(() => null)) as { deviceId?: string } | null;
        if (!body?.deviceId) return c.json({ error: 'deviceId is required' }, 400);

        const topic = await topicsRef.findByName({
          tenantId,
          name: c.req.param('topicName'),
        });
        if (!topic) return c.json({ ok: true }, 200);

        const subscription = await subscriptionsRef.findByDevice({
          userId: authUserId,
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
        const authUserId = c.get('authUserId');
        if (typeof authUserId !== 'string' || !deliveriesRef) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const deliveryId = c.req.param('deliveryId');
        const delivery = await deliveriesRef.markDelivered({ id: deliveryId, authUserId });
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
      });
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
  };
}

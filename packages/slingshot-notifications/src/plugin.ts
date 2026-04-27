import type {
  PluginSetupContext,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  defineEvent,
  getPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { createNotificationBuilder } from './builder';
import { createIntervalDispatcher } from './dispatcher';
import { notificationFactories, notificationPreferenceFactories } from './entities/factories';
import { Notification, notificationOperations } from './entities/notification';
import { NotificationPreference, notificationPreferenceOperations } from './entities/preference';
import { resolveRateLimitBackend } from './rateLimit';
import { createNotificationSseRoute } from './sse';
import { NOTIFICATIONS_PLUGIN_STATE_KEY } from './state';
import type { NotificationsPluginState } from './state';
import type {
  DeliveryAdapter,
  NotificationAdapter,
  NotificationCreatedEventPayload,
  NotificationPreferenceAdapter,
} from './types';
import type { NotificationsPluginConfig } from './types/config';
import { notificationsPluginConfigSchema } from './types/config';

type AdapterResult = BareEntityAdapter;
type DynamicBus = {
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
  off(event: string, handler: (payload: unknown) => void | Promise<void>): void;
};

/**
 * Create the shared notifications plugin.
 *
 * @param rawConfig - Notifications plugin config.
 * @returns Slingshot notifications plugin.
 */
export function createNotificationsPlugin(
  rawConfig: Partial<NotificationsPluginConfig> = {},
): SlingshotPlugin {
  const config = deepFreeze(
    validatePluginConfig('slingshot-notifications', rawConfig, notificationsPluginConfigSchema),
  );

  let notificationsAdapter: NotificationAdapter | undefined;
  let preferencesAdapter: NotificationPreferenceAdapter | undefined;
  let teardown: (() => Promise<void>) | undefined;
  const deliveryAdapters = new Set<DeliveryAdapter>();

  const entities: EntityPluginEntry[] = [
    {
      config: Notification,
      operations: notificationOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        const adapter = resolveRepo(notificationFactories, storeType, infra);
        notificationsAdapter = adapter as unknown as NotificationAdapter;
        return adapter as unknown as AdapterResult;
      },
    },
    {
      config: NotificationPreference,
      operations: notificationPreferenceOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        const adapter = resolveRepo(notificationPreferenceFactories, storeType, infra);
        preferencesAdapter = adapter as unknown as NotificationPreferenceAdapter;
        return adapter as unknown as AdapterResult;
      },
    },
  ];

  const innerPlugin = createEntityPlugin({
    name: NOTIFICATIONS_PLUGIN_STATE_KEY,
    mountPath: config.mountPath,
    entities,
  });

  return {
    name: NOTIFICATIONS_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth'],

    async setupMiddleware(ctx: PluginSetupContext) {
      if (!ctx.events.get('notifications:notification.created')) {
        ctx.events.register(
          defineEvent('notifications:notification.created', {
            ownerPlugin: NOTIFICATIONS_PLUGIN_STATE_KEY,
            exposure: ['client-safe', 'tenant-webhook', 'user-webhook'],
            resolveScope(payload, publishContext) {
              // Notification's own tenantId comes from the notification record (in payload).
              // Delivery scope mirrors the notification's tenant; envelope.requestTenantId
              // separately carries the originating-request tenant when applicable.
              return {
                tenantId: payload.notification?.tenantId ?? publishContext.requestTenantId ?? null,
                userId: publishContext.userId ?? null,
                actorId: publishContext.actorId ?? publishContext.userId ?? null,
              };
            },
          }),
        );
      }
      await innerPlugin.setupMiddleware?.(ctx);
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      if (config.sseEnabled) {
        app.route('/', createNotificationSseRoute(bus, config.ssePath));
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin.setupPost?.({ app, config: frameworkConfig, bus, events });

      if (!notificationsAdapter || !preferencesAdapter) {
        throw new Error(
          '[slingshot-notifications] Entity adapters were not resolved during setupRoutes',
        );
      }
      const notifications = notificationsAdapter;
      const preferences = preferencesAdapter;

      const rateLimitBackend = resolveRateLimitBackend(config.rateLimit.backend);
      const dispatcher = config.dispatcher.enabled
        ? createIntervalDispatcher({
            notifications,
            preferences,
            bus,
            events,
            defaultPreferences: config.defaultPreferences,
            intervalMs: config.dispatcher.intervalMs,
            maxPerTick: config.dispatcher.maxPerTick,
          })
        : {
            start() {},
            stop() {
              return Promise.resolve();
            },
            tick() {
              return Promise.resolve(0);
            },
          };

      const createdListener = async (payload: unknown) => {
        const event = payload as NotificationCreatedEventPayload;
        for (const adapter of deliveryAdapters) {
          try {
            await adapter.deliver(event);
          } catch (err) {
            console.error(
              '[slingshot-notifications] Delivery adapter failed for notifications:notification.created',
              err,
            );
          }
        }
      };

      (bus as unknown as DynamicBus).on('notifications:notification.created', createdListener);

      const state: NotificationsPluginState = deepFreeze({
        config,
        notifications: notificationsAdapter,
        preferences: preferencesAdapter,
        dispatcher,
        createBuilder: ({ source }) =>
          createNotificationBuilder({
            source,
            notifications,
            preferences,
            bus,
            events,
            rateLimitBackend,
            defaultPreferences: config.defaultPreferences,
            rateLimit: {
              limit: config.rateLimit.perSourcePerUserPerWindow,
              windowMs: config.rateLimit.windowMs,
            },
          }),
        registerDeliveryAdapter(adapter: DeliveryAdapter) {
          deliveryAdapters.add(adapter);
        },
      });

      getPluginState(app).set(NOTIFICATIONS_PLUGIN_STATE_KEY, state);
      dispatcher.start();

      teardown = async () => {
        (bus as unknown as DynamicBus).off('notifications:notification.created', createdListener);
        await dispatcher.stop();
        deliveryAdapters.clear();
        await rateLimitBackend.close?.();
      };
    },

    teardown() {
      return teardown?.() ?? Promise.resolve();
    },
  };
}

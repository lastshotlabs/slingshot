import type {
  MetricsEmitter,
  PluginSetupContext,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  createNoopMetricsEmitter,
  deepFreeze,
  defineEvent,
  getContextOrNull,
  getPluginState,
  publishPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
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
  NotificationRecord,
} from './types';
import type { NotificationsPluginConfig } from './types/config';
import { notificationsPluginConfigSchema } from './types/config';

type AdapterResult = BareEntityAdapter;
type ActorParam = { 'actor.id': string };
type GeneratedNotificationAdapter = NotificationAdapter & {
  listByUser(params: ActorParam): ReturnType<NotificationAdapter['listByUser']>;
  listUnread(params: ActorParam): ReturnType<NotificationAdapter['listUnread']>;
  markRead(
    params: { id: string } & ActorParam,
    input: { read: boolean; readAt: Date },
  ): ReturnType<NotificationAdapter['markRead']>;
  markAllRead(params: ActorParam): ReturnType<NotificationAdapter['markAllRead']>;
  unreadCount(params: ActorParam): ReturnType<NotificationAdapter['unreadCount']>;
  unreadCountBySource(
    params: { source: string } & ActorParam,
  ): ReturnType<NotificationAdapter['unreadCountBySource']>;
  unreadCountByScope(
    params: { source: string; scopeId: string } & ActorParam,
  ): ReturnType<NotificationAdapter['unreadCountByScope']>;
  hasUnreadByDedupKey(
    params: { dedupKey: string } & ActorParam,
  ): ReturnType<NotificationAdapter['hasUnreadByDedupKey']>;
};
type GeneratedPreferenceAdapter = NotificationPreferenceAdapter & {
  listByUser(params: ActorParam): ReturnType<NotificationPreferenceAdapter['listByUser']>;
};

function toActorParam(params: { userId: string }): ActorParam {
  return { 'actor.id': params.userId };
}

/**
 * Filter list responses by `notificationTtlMs` so expired rows don't appear
 * to clients before the periodic sweep deletes them. P-NOTIF-8.
 */
function isExpired(record: NotificationRecord, ttlMs: number, nowMs: number): boolean {
  if (ttlMs <= 0) return false;
  const created = record.createdAt;
  const createdMs =
    created instanceof Date
      ? created.getTime()
      : typeof created === 'string'
        ? Date.parse(created)
        : NaN;
  if (Number.isNaN(createdMs)) return false;
  return nowMs - createdMs > ttlMs;
}

function filterExpired<T extends { items: NotificationRecord[] }>(result: T, ttlMs: number): T {
  if (ttlMs <= 0) return result;
  const nowMs = Date.now();
  const items = result.items.filter(r => !isExpired(r, ttlMs, nowMs));
  return { ...result, items };
}

function wrapNotificationAdapter(adapter: NotificationAdapter, ttlMs: number): NotificationAdapter {
  const generated = adapter as GeneratedNotificationAdapter;
  return {
    ...adapter,
    listByUser: async params =>
      filterExpired(await generated.listByUser(toActorParam(params)), ttlMs),
    listUnread: async params =>
      filterExpired(await generated.listUnread(toActorParam(params)), ttlMs),
    markRead: params =>
      generated.markRead(
        { id: params.id, ...toActorParam(params) },
        { read: true, readAt: new Date() },
      ),
    markAllRead: params => generated.markAllRead(toActorParam(params)),
    unreadCount: params => generated.unreadCount(toActorParam(params)),
    unreadCountBySource: params =>
      generated.unreadCountBySource({ source: params.source, ...toActorParam(params) }),
    unreadCountByScope: params =>
      generated.unreadCountByScope({
        source: params.source,
        scopeId: params.scopeId,
        ...toActorParam(params),
      }),
    hasUnreadByDedupKey: params =>
      generated.hasUnreadByDedupKey({
        dedupKey: params.dedupKey,
        ...toActorParam(params),
      }),
  };
}

function wrapPreferenceAdapter(
  adapter: NotificationPreferenceAdapter,
): NotificationPreferenceAdapter {
  const generated = adapter as GeneratedPreferenceAdapter;
  return {
    ...adapter,
    listByUser: params => generated.listByUser(toActorParam(params)),
  };
}

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

  // The unified metrics emitter is owned by the framework context and not
  // available until `setupPost` runs. Resolve lazily through this proxy so
  // the dispatcher and builders see the framework-owned emitter at call
  // time without needing re-construction.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  const entities: EntityPluginEntry[] = [
    {
      config: Notification,
      operations: notificationOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        // The generated entity adapter exposes both the BareEntityAdapter CRUD
        // surface and the named-operation methods declared in
        // notificationOperations. Its inferred type is
        // BareEntityAdapter | Record<string, unknown>, which does not
        // structurally overlap with NotificationAdapter — go through `unknown`
        // to bridge the boundary. wrapNotificationAdapter() then enforces the
        // actor-param contract at every call site.
        const adapter = resolveRepo(notificationFactories, storeType, infra);
        notificationsAdapter = adapter as unknown as NotificationAdapter;
        return adapter as unknown as AdapterResult;
      },
    },
    {
      config: NotificationPreference,
      operations: notificationPreferenceOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        // Same boundary as Notification above: bridge generated entity adapter
        // shape to the typed NotificationPreferenceAdapter contract.
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

      // Resolve the framework-owned metrics emitter so the dispatcher and
      // per-source builders publish counters/gauges/timings on hot paths.
      const ctx = getContextOrNull(app);
      if (ctx?.metricsEmitter) resolvedMetricsEmitter = ctx.metricsEmitter;

      if (!notificationsAdapter || !preferencesAdapter) {
        throw new Error(
          '[slingshot-notifications] Entity adapters were not resolved during setupRoutes',
        );
      }
      const notifications = wrapNotificationAdapter(notificationsAdapter, config.notificationTtlMs);
      const preferences = wrapPreferenceAdapter(preferencesAdapter);

      // Trigger the entity adapter's lazy ensureTable() before any custom op
      // (e.g. dedupOrCreate) runs. The entity wiring layer does not pass the
      // ensureTable hook into custom-op factories, so without this pre-warm a
      // first-call dedupOrCreate would hit "no such table" on a fresh DB.
      try {
        await notifications.list({ limit: 1 });
      } catch (err) {
        console.error(
          '[slingshot-notifications] Failed to pre-warm notifications storage; first dedupOrCreate may fail',
          err,
        );
      }

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
            metrics: metricsProxy,
          })
        : {
            start() {},
            stop() {
              return Promise.resolve();
            },
            tick() {
              return Promise.resolve(0);
            },
            getHealth() {
              return {
                pendingCount: null,
                pendingCountIsLowerBound: false,
                lastTickAt: null,
                lastDispatchedCount: null,
                pendingAlarmActive: false,
                openBreakerCount: 0,
              };
            },
          };

      const createdListener = async (payload: unknown) => {
        const event = payload as NotificationCreatedEventPayload;
        let adapterIndex = 0;
        for (const adapter of deliveryAdapters) {
          try {
            await adapter.deliver(event);
          } catch (err) {
            console.error(
              `[slingshot-notifications] Delivery adapter [${adapterIndex}] threw for notification "${event.notification.id}"`,
              err,
            );
          }
          adapterIndex++;
        }
      };

      bus.on('notifications:notification.created', createdListener);

      const state: NotificationsPluginState = deepFreeze({
        config,
        notifications,
        preferences,
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
            metrics: metricsProxy,
          }),
        registerDeliveryAdapter(adapter: DeliveryAdapter) {
          deliveryAdapters.add(adapter);
        },
      });

      publishPluginState(getPluginState(app), NOTIFICATIONS_PLUGIN_STATE_KEY, state);
      dispatcher.start();

      // P-NOTIF-8: optional periodic sweep that deletes expired notifications.
      let sweepTimer: ReturnType<typeof setInterval> | null = null;
      if (config.notificationTtlMs > 0) {
        const ttlMs = config.notificationTtlMs;
        const sweep = async (): Promise<void> => {
          const cutoff = Date.now() - ttlMs;
          try {
            // Page through everything; the underlying adapter accepts a
            // generic `opts` map. Deletion happens one record at a time so a
            // partial failure does not poison the rest of the sweep.
            const all = await notifications.list({ limit: 500 });
            for (const row of all.items) {
              const created =
                row.createdAt instanceof Date
                  ? row.createdAt.getTime()
                  : typeof row.createdAt === 'string'
                    ? Date.parse(row.createdAt)
                    : NaN;
              if (!Number.isFinite(created) || created > cutoff) continue;
              try {
                await notifications.delete(row.id);
              } catch (err) {
                console.error(
                  `[slingshot-notifications] expiry sweep delete failed for id=${row.id}`,
                  err,
                );
              }
            }
          } catch (err) {
            console.error('[slingshot-notifications] expiry sweep failed', err);
          }
        };
        // Fire-and-forget initial sweep so apps that just enabled TTL get
        // immediate cleanup of historical data.
        void sweep();
        sweepTimer = setInterval(() => {
          void sweep();
        }, config.notificationSweepIntervalMs);
      }

      teardown = async () => {
        bus.off('notifications:notification.created', createdListener);
        if (sweepTimer) {
          clearInterval(sweepTimer);
          sweepTimer = null;
        }
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

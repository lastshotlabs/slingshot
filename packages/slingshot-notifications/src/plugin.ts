import type {
  MetricsEmitter,
  PluginSetupContext,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  createNoopMetricsEmitter,
  deepFreeze,
  defineEvent,
  definePackage,
  getContextOrNull,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from './builder';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from './dispatcher';
import type { DispatcherAdapter } from './dispatcher';
import { buildNotificationsEntityModules } from './entities/modules';
import {
  NotificationsBuilderFactory,
  NotificationsDeliveryRegistry,
  NotificationsHealthCap,
} from './public';
import type { NotificationsHealth } from './public';
import { resolveRateLimitBackend } from './rateLimit';
import { createNotificationSseRoute } from './sse';
import type {
  DeliveryAdapter,
  NotificationAdapter,
  NotificationCreatedEventPayload,
  NotificationPreferenceAdapter,
  NotificationRecord,
} from './types';
import type { NotificationsPluginConfig } from './types/config';
import { notificationsPluginConfigSchema } from './types/config';

// Stable identifier for this package. Used as the contract owner name when
// registering capabilities and as the package `name` in `definePackage`.
const NOTIFICATIONS_PLUGIN_NAME = 'slingshot-notifications' as const;

const pluginLogger: Logger = createConsoleLogger({ base: { plugin: 'slingshot-notifications' } });

type ActorParam = { 'actor.id': string };

function errorLogFields(err: unknown): { err: string; name?: string } {
  if (err instanceof Error) return { err: err.message, name: err.name };
  return { err: String(err) };
}

function validateNotificationAdapter(adapter: unknown): NotificationAdapter {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new Error('Notification adapter is not an object');
  }
  const required = [
    'create',
    'getById',
    'update',
    'delete',
    'list',
    'clear',
    'listByUser',
    'listUnread',
    'markRead',
    'markAllRead',
    'unreadCount',
    'unreadCountBySource',
    'unreadCountByScope',
    'hasUnreadByDedupKey',
    'findByDedupKey',
    'dedupOrCreate',
    'listPendingDispatch',
    'markDispatched',
  ] as const;
  for (const method of required) {
    if (typeof (adapter as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`Notification adapter missing required method: ${method}`);
    }
  }
  return adapter as NotificationAdapter;
}

function validateNotificationPreferenceAdapter(adapter: unknown): NotificationPreferenceAdapter {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new Error('NotificationPreference adapter is not an object');
  }
  const required = [
    'create',
    'getById',
    'update',
    'delete',
    'list',
    'clear',
    'listByUser',
    'resolveForNotification',
  ] as const;
  for (const method of required) {
    if (typeof (adapter as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`NotificationPreference adapter missing required method: ${method}`);
    }
  }
  return adapter as NotificationPreferenceAdapter;
}
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
 * Create the shared notifications package.
 *
 * Two entity modules (Notification, NotificationPreference) flow through the
 * declarative package entity-mounting path; imperative work (event registration,
 * SSE route, dispatcher startup, capability publication, TTL sweep) lives in
 * `setupMiddleware` / `setupRoutes` / `setupPost`.
 *
 * Health observability is exposed through the `NotificationsHealthCap`
 * capability — cross-package consumers resolve it via
 * `ctx.capabilities.require(NotificationsHealthCap)()`.
 *
 * @param rawConfig - Notifications package config.
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 */
export function createNotificationsPackage(
  rawConfig: Partial<NotificationsPluginConfig> = {},
): SlingshotPackageDefinition {
  const config = deepFreeze(
    validatePluginConfig('slingshot-notifications', rawConfig, notificationsPluginConfigSchema),
  );

  // Closure-owned adapter refs populated by the entity modules' `onAdapter`
  // callbacks during bootstrap. The dispatcher, TTL sweep, and builder factory
  // ALL read from these refs — sharing a single adapter instance per entity
  // between the entity routes and the package's imperative work is critical
  // for memory-store correctness (a separate `resolveRepo` call would create
  // a divergent in-memory store).
  let notificationsAdapter: NotificationAdapter | undefined;
  let preferencesAdapter: NotificationPreferenceAdapter | undefined;
  let teardown: (() => Promise<void>) | undefined;
  const deliveryAdapters = new Set<DeliveryAdapter>();
  // Hoisted so the health capability can reference it. Assigned in setupPost.
  let dispatcher!: DispatcherAdapter;
  // Hoisted refs read by the declarative capability resolvers. Populated in
  // setupPost; resolvers throw a clear "not ready" error when read earlier.
  let builderFactoryRef: ((opts: { source: string }) => NotificationBuilder) | undefined;
  const deliveryRegistry: NotificationsDeliveryRegistry = {
    register(adapter: DeliveryAdapter) {
      deliveryAdapters.add(adapter);
    },
  };

  const { notificationModule, notificationPreferenceModule } = buildNotificationsEntityModules({
    onNotificationAdapter: adapter => {
      notificationsAdapter = validateNotificationAdapter(adapter);
    },
    onPreferenceAdapter: adapter => {
      preferencesAdapter = validateNotificationPreferenceAdapter(adapter);
    },
  });

  // The unified metrics emitter is owned by the framework context and not
  // available until `setupPost` runs. Resolve lazily through this proxy so the
  // dispatcher and builders see the framework-owned emitter at call time
  // without needing re-construction.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  function buildHealth(): NotificationsHealth {
    const adapterAvailable = notificationsAdapter != null;
    const preferencesAvailable = preferencesAdapter != null;
    const dispatchCount = deliveryAdapters.size;

    let status: NotificationsHealth['status'] = 'healthy';
    if (!adapterAvailable || !preferencesAvailable) {
      status = 'unhealthy';
    } else if (dispatchCount === 0) {
      status = 'degraded';
    }

    return {
      status,
      details: {
        adapterAvailable,
        preferencesAdapterAvailable: preferencesAvailable,
        deliveryAdapterCount: dispatchCount,
        rateLimitBackend: config.rateLimit.backend,
        dispatcherHealth: dispatcher.getHealth(),
      },
    };
  }

  return definePackage({
    name: NOTIFICATIONS_PLUGIN_NAME,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    entities: [notificationModule, notificationPreferenceModule],
    capabilities: {
      provides: [
        provideCapability(NotificationsBuilderFactory, () => {
          if (!builderFactoryRef) {
            throw new Error(
              '[slingshot-notifications] builder factory requested before setupPost completed; consumers must read NotificationsBuilderFactory from setupPost or later.',
            );
          }
          return builderFactoryRef;
        }),
        provideCapability(NotificationsDeliveryRegistry, () => deliveryRegistry),
        provideCapability(NotificationsHealthCap, () => buildHealth),
      ],
    },

    setupMiddleware({ events }: PluginSetupContext) {
      // Entity adapters are populated by the entity modules' `onAdapter`
      // callbacks during the framework's entity-bootstrap step (which runs
      // alongside setupMiddleware). The closures that consume them
      // (dispatcher, builder, TTL sweep) are wired in setupPost — by then
      // both refs are guaranteed populated.
      if (!events.get('notifications:notification.created')) {
        events.register(
          defineEvent('notifications:notification.created', {
            ownerPlugin: NOTIFICATIONS_PLUGIN_NAME,
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
    },

    setupRoutes({ app, bus }: PluginSetupContext) {
      if (config.sseEnabled) {
        app.route('/', createNotificationSseRoute(bus, config.ssePath));
      }
    },

    async setupPost({ app, bus, events }: PluginSetupContext) {
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
        pluginLogger.error(
          '[slingshot-notifications] Failed to pre-warm notifications storage; first dedupOrCreate may fail',
          errorLogFields(err),
        );
      }

      const rateLimitBackend = resolveRateLimitBackend(config.rateLimit.backend);
      dispatcher = config.dispatcher.enabled
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
            pluginLogger.error(
              `[slingshot-notifications] Delivery adapter [${adapterIndex}] threw for notification "${event.notification.id}"`,
              errorLogFields(err),
            );
          }
          adapterIndex++;
        }
      };

      bus.on('notifications:notification.created', createdListener);

      const builderFactory = ({ source }: { source: string }) =>
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
        });

      // Capability publication is declarative on the package — see
      // `definePackage({ capabilities: { provides: [...] } })` above. We just
      // populate the hoisted ref so resolvers stop throwing.
      builderFactoryRef = builderFactory;

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
                pluginLogger.error(
                  `[slingshot-notifications] expiry sweep delete failed for id=${row.id}`,
                  errorLogFields(err),
                );
              }
            }
          } catch (err) {
            pluginLogger.error(
              '[slingshot-notifications] expiry sweep failed',
              errorLogFields(err),
            );
            try {
              bus.emit('notifications:expiry-sweep.failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            } catch {
              // bus emission is best-effort
            }
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
  });
}

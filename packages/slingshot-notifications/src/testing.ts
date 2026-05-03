import { Hono } from 'hono';
import {
  InProcessAdapter,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createPluginStateMap,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus, SlingshotEvents } from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from './builder';
import { notificationFactories, notificationPreferenceFactories } from './entities/factories';
import { DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS } from './preferences';
import { createNoopRateLimitBackend } from './rateLimit';
import { NOTIFICATIONS_PLUGIN_STATE_KEY } from './state';
import type {
  NotificationAdapter,
  NotificationPreferenceAdapter,
  NotificationPreferenceRecord,
  NotificationRecord,
} from './types';

type MemoryNotificationEntityAdapter = ReturnType<typeof notificationFactories.memory>;
type MemoryNotificationPreferenceEntityAdapter = ReturnType<
  typeof notificationPreferenceFactories.memory
>;

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

function getAsyncMethod(target: object, name: string): AsyncMethod {
  const value = (target as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(`[slingshot-notifications] Missing adapter method "${name}"`);
  }
  return value as AsyncMethod;
}

function toCountResult(value: unknown): { count: number } {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { count?: unknown }).count === 'number'
  ) {
    return { count: (value as { count: number }).count };
  }
  return { count: 0 };
}

function toNotificationRecord(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    userId: String(row.userId),
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : null,
    source: String(row.source),
    type: String(row.type),
    actorId: typeof row.actorId === 'string' ? row.actorId : null,
    targetType: typeof row.targetType === 'string' ? row.targetType : null,
    targetId: typeof row.targetId === 'string' ? row.targetId : null,
    dedupKey: typeof row.dedupKey === 'string' ? row.dedupKey : null,
    data:
      row.data && typeof row.data === 'object'
        ? (row.data as Readonly<Record<string, unknown>>)
        : undefined,
    read: row.read === true,
    readAt: row.readAt instanceof Date || typeof row.readAt === 'string' ? row.readAt : null,
    deliverAt:
      row.deliverAt instanceof Date || typeof row.deliverAt === 'string' ? row.deliverAt : null,
    dispatched: row.dispatched === true,
    dispatchedAt:
      row.dispatchedAt instanceof Date || typeof row.dispatchedAt === 'string'
        ? row.dispatchedAt
        : null,
    scopeId: typeof row.scopeId === 'string' ? row.scopeId : null,
    priority:
      row.priority === 'low' ||
      row.priority === 'normal' ||
      row.priority === 'high' ||
      row.priority === 'urgent'
        ? row.priority
        : 'normal',
    createdAt:
      row.createdAt instanceof Date || typeof row.createdAt === 'string'
        ? row.createdAt
        : new Date(0),
  };
}

function toActorParam(params: { userId: string }): { 'actor.id': string } {
  return { 'actor.id': params.userId };
}

function toPreferenceRecord(row: Record<string, unknown>): NotificationPreferenceRecord {
  return {
    id: String(row.id),
    userId: String(row.userId),
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : null,
    scope: row.scope === 'source' || row.scope === 'type' ? row.scope : 'global',
    source: typeof row.source === 'string' ? row.source : null,
    type: typeof row.type === 'string' ? row.type : null,
    muted: row.muted === true,
    pushEnabled: row.pushEnabled !== false,
    emailEnabled: row.emailEnabled !== false,
    inAppEnabled: row.inAppEnabled !== false,
    quietStart: typeof row.quietStart === 'string' ? row.quietStart : null,
    quietEnd: typeof row.quietEnd === 'string' ? row.quietEnd : null,
    updatedAt:
      row.updatedAt instanceof Date || typeof row.updatedAt === 'string'
        ? row.updatedAt
        : new Date(0),
  };
}

function wrapNotificationAdapter(adapter: MemoryNotificationEntityAdapter): NotificationAdapter {
  const listPendingDispatch = getAsyncMethod(adapter as object, 'listPendingDispatch');
  const countPendingDispatch = getAsyncMethod(adapter as object, 'countPendingDispatch');
  const markDispatched = getAsyncMethod(adapter as object, 'markDispatched');
  const markAllRead = getAsyncMethod(adapter as object, 'markAllRead');
  const markRead = getAsyncMethod(adapter as object, 'markRead');
  const unreadCount = getAsyncMethod(adapter as object, 'unreadCount');
  const unreadCountBySource = getAsyncMethod(adapter as object, 'unreadCountBySource');
  const unreadCountByScope = getAsyncMethod(adapter as object, 'unreadCountByScope');
  const dedupOrCreate = getAsyncMethod(adapter as object, 'dedupOrCreate');

  return {
    async create(input) {
      return toNotificationRecord((await adapter.create(input)) as Record<string, unknown>);
    },
    async getById(id) {
      const row = (await adapter.getById(id)) as Record<string, unknown> | null;
      return row ? toNotificationRecord(row) : null;
    },
    async update(id, input) {
      const row = (await adapter.update(id, input)) as Record<string, unknown> | null;
      return row ? toNotificationRecord(row) : null;
    },
    delete(id) {
      return adapter.delete(id);
    },
    async list(opts) {
      const result = await adapter.list(opts);
      return {
        items: result.items.map(item => toNotificationRecord(item as Record<string, unknown>)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
    clear() {
      return adapter.clear();
    },
    async listByUser(params) {
      const result = await adapter.listByUser(toActorParam(params));
      return {
        items: result.items.map(item => toNotificationRecord(item as Record<string, unknown>)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
    async listUnread(params) {
      const result = await adapter.listUnread(toActorParam(params));
      return {
        items: result.items.map(item => toNotificationRecord(item as Record<string, unknown>)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
    async markRead(params) {
      const row = (await markRead(
        { id: params.id, ...toActorParam(params) },
        { read: true, readAt: new Date() },
      )) as Record<string, unknown> | null;
      return row ? toNotificationRecord(row) : null;
    },
    async markAllRead(params) {
      return (await markAllRead(toActorParam(params))) as { count: number } | number;
    },
    async unreadCount(params) {
      return toCountResult(await unreadCount(toActorParam(params)));
    },
    async unreadCountBySource(params) {
      return toCountResult(
        await unreadCountBySource({ ...toActorParam(params), source: params.source }),
      );
    },
    async unreadCountByScope(params) {
      return toCountResult(
        await unreadCountByScope({
          ...toActorParam(params),
          source: params.source,
          scopeId: params.scopeId,
        }),
      );
    },
    hasUnreadByDedupKey(params) {
      return adapter.hasUnreadByDedupKey({
        ...toActorParam(params),
        dedupKey: params.dedupKey,
      });
    },
    async findByDedupKey(params) {
      const row = (await adapter.findByDedupKey(params)) as Record<string, unknown> | null;
      return row ? toNotificationRecord(row) : null;
    },
    async dedupOrCreate(params) {
      const result = (await dedupOrCreate(params)) as {
        record: Record<string, unknown>;
        created: boolean;
      } | null;
      if (!result) {
        throw new Error('[slingshot-notifications] dedupOrCreate returned no result');
      }
      return {
        record: toNotificationRecord(result.record),
        created: result.created,
      };
    },
    async listPendingDispatch(params) {
      const result = (await listPendingDispatch(params)) as {
        records: unknown[];
        nextCursor: string | null;
      };
      return {
        records: (result.records ?? [])
          .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
          .map(row => toNotificationRecord(row)),
        nextCursor: result.nextCursor ?? null,
      };
    },
    async countPendingDispatch(params) {
      const value = (await countPendingDispatch(params)) as unknown;
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    },
    async markDispatched(params) {
      await markDispatched(params);
    },
  };
}

function wrapPreferenceAdapter(
  adapter: MemoryNotificationPreferenceEntityAdapter,
): NotificationPreferenceAdapter {
  const resolveForNotification = getAsyncMethod(adapter as object, 'resolveForNotification');

  return {
    async create(input) {
      return toPreferenceRecord((await adapter.create(input)) as Record<string, unknown>);
    },
    async getById(id) {
      const row = (await adapter.getById(id)) as Record<string, unknown> | null;
      return row ? toPreferenceRecord(row) : null;
    },
    async update(id, input) {
      const row = (await adapter.update(id, input)) as Record<string, unknown> | null;
      return row ? toPreferenceRecord(row) : null;
    },
    delete(id) {
      return adapter.delete(id);
    },
    async list(opts) {
      const result = await adapter.list(opts);
      return {
        items: result.items.map(item => toPreferenceRecord(item as Record<string, unknown>)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
    clear() {
      return adapter.clear();
    },
    async listByUser(params) {
      const result = await adapter.listByUser(toActorParam(params));
      return {
        items: result.items.map(item => toPreferenceRecord(item as Record<string, unknown>)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
    async resolveForNotification(params) {
      const rows = (await resolveForNotification(params)) as unknown[];
      return rows
        .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
        .map(row => toPreferenceRecord(row));
    },
  };
}

function registerNotificationsTestDefinitions(events: SlingshotEvents): void {
  const exposure = ['client-safe', 'tenant-webhook', 'user-webhook'] as const;

  if (!events.get('notifications:notification.created')) {
    events.register(
      defineEvent('notifications:notification.created', {
        ownerPlugin: NOTIFICATIONS_PLUGIN_STATE_KEY,
        exposure,
        resolveScope(payload) {
          return {
            tenantId: payload.notification.tenantId ?? null,
            userId: payload.notification.userId,
            actorId: payload.notification.actorId ?? payload.notification.userId,
          };
        },
      }),
    );
  }

  if (!events.get('notifications:notification.updated')) {
    events.register(
      defineEvent('notifications:notification.updated', {
        ownerPlugin: NOTIFICATIONS_PLUGIN_STATE_KEY,
        exposure,
        resolveScope(payload) {
          return {
            tenantId: payload.tenantId ?? null,
            userId: payload.userId ?? null,
            actorId: payload.userId ?? null,
          };
        },
      }),
    );
  }

  if (!events.get('notifications:notification.read')) {
    events.register(
      defineEvent('notifications:notification.read', {
        ownerPlugin: NOTIFICATIONS_PLUGIN_STATE_KEY,
        exposure,
        resolveScope(payload) {
          return {
            tenantId: payload.tenantId ?? null,
            userId: payload.userId ?? null,
            actorId: payload.userId ?? null,
          };
        },
      }),
    );
  }
}

export function createNotificationsTestEvents(
  bus: SlingshotEventBus,
  options: { registerDefinitions?: boolean } = {},
): SlingshotEvents {
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  if (options.registerDefinitions !== false) {
    registerNotificationsTestDefinitions(events);
  }
  return events;
}

/**
 * Create in-memory adapters and a builder for notification tests.
 *
 * @returns In-memory notification test helpers.
 */
export function createNotificationsTestAdapters() {
  const notifications = wrapNotificationAdapter(notificationFactories.memory());
  const preferences = wrapPreferenceAdapter(notificationPreferenceFactories.memory());
  const bus = new InProcessAdapter();
  const events = createNotificationsTestEvents(bus);

  return {
    notifications,
    preferences,
    createBuilder(source: string) {
      return createNotificationBuilder({
        source,
        notifications,
        preferences,
        bus,
        events,
        rateLimitBackend: createNoopRateLimitBackend(),
        defaultPreferences: DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS,
        rateLimit: { limit: 10_000, windowMs: 60_000 },
      });
    },
    async clear() {
      await Promise.all([notifications.clear(), preferences.clear()]);
    },
  };
}

/**
 * Create a minimal in-memory notifications runtime for tests.
 *
 * @returns Test app, event bus, adapters, and builder helpers.
 */
export function createNotificationsTestBootstrap() {
  const app = new Hono();
  const bus = new InProcessAdapter();
  const events = createNotificationsTestEvents(bus);
  const adapters = createNotificationsTestAdapters();

  attachContext(app, {
    app,
    pluginState: createPluginStateMap([
      [
        NOTIFICATIONS_PLUGIN_STATE_KEY,
        {
          notifications: adapters.notifications,
          preferences: adapters.preferences,
          createBuilder: ({ source }: { source: string }) => adapters.createBuilder(source),
          dispatcher: {
            start() {},
            stop() {},
            tick() {
              return Promise.resolve(0);
            },
          },
          registerDeliveryAdapter() {},
          config: Object.freeze({
            mountPath: '/notifications',
            sseEnabled: true,
            ssePath: '/notifications/sse',
            dispatcher: { enabled: true, intervalMs: 30_000, maxPerTick: 500 },
            rateLimit: {
              perSourcePerUserPerWindow: 100,
              windowMs: 3_600_000,
              backend: 'memory',
            },
            defaultPreferences: DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS,
          }),
        },
      ],
    ]),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  return {
    app,
    bus,
    events,
    notifications: adapters.notifications,
    preferences: adapters.preferences,
    builder: adapters.createBuilder('test'),
    createBuilder: (source: string) => adapters.createBuilder(source),
    clear: () => adapters.clear(),
  };
}

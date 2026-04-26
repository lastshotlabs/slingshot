import type { SlingshotEventBus, SlingshotEvents } from '@lastshotlabs/slingshot-core';
import { DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS, resolvePreferences } from './preferences';
import type {
  NotificationAdapter,
  NotificationCreatedEventPayload,
  NotificationPreferenceAdapter,
  NotificationPreferenceDefaults,
} from './types';

export interface DispatcherAdapter {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
}

export interface CreateIntervalDispatcherOptions {
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly bus: SlingshotEventBus;
  readonly events: SlingshotEvents;
  readonly defaultPreferences?: NotificationPreferenceDefaults;
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
}

/**
 * Create the default polling dispatcher for scheduled notifications.
 *
 * @param options - Dispatcher dependencies.
 * @returns Polling dispatcher.
 */
export function createIntervalDispatcher(
  options: CreateIntervalDispatcherOptions,
): DispatcherAdapter {
  const intervalMs = options.intervalMs ?? 30_000;
  const maxPerTick = options.maxPerTick ?? 500;
  const defaultPreferences = options.defaultPreferences ?? DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick();
      }, intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    async tick() {
      const dispatchedAt = new Date();
      const rows = await options.notifications.listPendingDispatch({
        limit: maxPerTick,
        now: dispatchedAt,
      });

      const safeRows = rows.slice(0, maxPerTick * 4);
      if (rows.length > safeRows.length) {
        console.warn(
          `[slingshot-notifications] Dropped ${rows.length - safeRows.length} pending notifications above dispatcher safety cap.`,
        );
      }

      for (const row of safeRows.slice(0, maxPerTick)) {
        await options.notifications.markDispatched({ id: row.id, dispatchedAt });
        const preferences = await resolvePreferences(
          options.preferences,
          row.userId,
          row.source,
          row.type,
          defaultPreferences,
        );
        const payload: NotificationCreatedEventPayload = {
          notification: row,
          preferences,
        };
        options.events.publish('notifications:notification.created', payload, {
          userId: row.userId,
          actorId: row.actorId ?? row.userId,
          source: 'system',
          // Background dispatcher — no originating HTTP request.
          requestTenantId: null,
        });
      }

      return Math.min(safeRows.length, maxPerTick);
    },
  };
}

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
  stop(): Promise<void>;
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
  let inflightTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (inflightTick) return;
    let resolve!: () => void;
    inflightTick = new Promise<void>(r => {
      resolve = r;
    });
    try {
      await dispatcher.tick();
    } catch (err) {
      console.error('[slingshot-notifications] Dispatcher tick failed', err);
    } finally {
      inflightTick = null;
      resolve();
    }
  }

  const dispatcher: DispatcherAdapter = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runTick();
      }, intervalMs);
    },
    async stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      try {
        await inflightTick;
      } catch (err) {
        console.error('[slingshot-notifications] Dispatcher stop(): inflight tick rejected', err);
      }
    },
    async tick() {
      const dispatchedAt = new Date();
      const rows = await options.notifications.listPendingDispatch({
        limit: maxPerTick,
        now: dispatchedAt,
      });

      let dispatchedCount = 0;

      for (const row of rows.slice(0, maxPerTick)) {
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

        await options.notifications.markDispatched({ id: row.id, dispatchedAt });
        try {
          options.events.publish('notifications:notification.created', payload, {
            userId: row.userId,
            actorId: row.actorId ?? row.userId,
            source: 'system',
            // Background dispatcher — no originating HTTP request.
            requestTenantId: null,
          });
          dispatchedCount += 1;
        } catch (err) {
          try {
            await options.notifications.update(row.id, {
              dispatched: false,
              dispatchedAt: null,
            });
          } catch (rollbackErr) {
            console.error(
              `[slingshot-notifications] Failed to roll back dispatched state for notification '${row.id}'`,
              rollbackErr,
            );
          }
          console.error(
            `[slingshot-notifications] Failed to publish notification '${row.id}' after marking it dispatched`,
            err,
          );
        }
      }

      return dispatchedCount;
    },
  };

  return dispatcher;
}

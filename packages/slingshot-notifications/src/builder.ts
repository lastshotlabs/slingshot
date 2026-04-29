import type {
  DynamicEventBus,
  Logger,
  MetricsEmitter,
  NotificationBuilder,
  NotificationCreatedEventPayload,
  NotificationRecord,
  NotifyInput,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { createConsoleLogger, createNoopMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { freezeNotificationData } from './data';
import { resolveEffectivePriority, resolvePreferences } from './preferences';
import type { RateLimitBackend } from './rateLimit';
import type {
  NotificationAdapter,
  NotificationPreferenceAdapter,
  NotificationPreferenceDefaults,
  NotificationPriority,
} from './types';

function readCount(data: Readonly<Record<string, unknown>> | undefined): number {
  const raw = data?.count;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
}

export interface CreateNotificationBuilderOptions {
  /** Notification source identifier (e.g. "community", "push"). Used for preference resolution and rate-limit scoping. */
  readonly source: string;
  /** Notification persistence adapter. */
  readonly notifications: NotificationAdapter;
  /** Preference persistence adapter. */
  readonly preferences: NotificationPreferenceAdapter;
  /** In-process event bus for internal event emission. */
  readonly bus: SlingshotEventBus;
  /** Typed event publisher for framework-level notification events. */
  readonly events: SlingshotEvents;
  /** Rate-limit backend for per-source-per-user throttling. */
  readonly rateLimitBackend: RateLimitBackend;
  /** Default channel preferences when no user preference record exists. */
  readonly defaultPreferences: NotificationPreferenceDefaults;
  /** Per-source-per-user rate-limit window configuration. */
  readonly rateLimit: {
    readonly limit: number;
    readonly windowMs: number;
  };
  /**
   * Optional unified metrics emitter. Defaults to a no-op. When provided, the
   * builder records `notifications.dedup.hits` whenever `dedupOrCreate` finds
   * an existing row.
   */
  readonly metrics?: MetricsEmitter;
  /**
   * Optional structured logger. Defaults to the console-backed logger so
   * publish errors and rate-limit faults are not silently swallowed.
   */
  readonly logger?: Logger;
  /**
   * Optional callback invoked when `events.publish()` rejects so apps can
   * implement retry logic (e.g. enqueue the failed publish into a durable
   * queue). When omitted the builder still logs and emits
   * `notify:publishFailed`. P-NOTIF-7.
   */
  readonly onPublishError?: (input: {
    event: string;
    payload: unknown;
    error: Error;
  }) => void | Promise<void>;
}

/**
 * Create a source-scoped notification builder.
 *
 * The returned builder provides a fluent API for creating, scheduling, and
 * managing notifications within a single source scope. All methods
 * automatically resolve user preferences, enforce rate limits, and handle
 * dedup key collision.
 *
 * @example
 * ```ts
 * const builder = createNotificationBuilder({
 *   source: 'community',
 *   notifications: myNotificationAdapter,
 *   preferences: myPreferenceAdapter,
 *   bus: myBus,
 *   events: myEvents,
 *   rateLimitBackend: myRateLimiter,
 *   defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
 *   rateLimit: { limit: 100, windowMs: 60_000 },
 * });
 *
 * await builder.notify({ userId: 'user-abc', type: 'mention', targetType: 'post', targetId: 'p1' });
 * await builder.notifyMany({ userIds: ['u1', 'u2'], type: 'announcement' });
 * ```
 *
 * @param options - Builder dependencies.
 * @returns Source-scoped builder.
 */
export function createNotificationBuilder(
  options: CreateNotificationBuilderOptions,
): NotificationBuilder {
  const metrics: MetricsEmitter = options.metrics ?? createNoopMetricsEmitter();
  const logger: Logger =
    options.logger ?? createConsoleLogger({ base: { plugin: 'slingshot-notifications' } });
  const dynamicBus = options.bus as unknown as DynamicEventBus;

  function reportPublishError(event: string, payload: unknown, err: Error): void {
    logger.error('event publish failed', {
      event,
      err: err.message,
      name: err.name,
    });
    metrics.counter('notifications.publish.failure', 1, { event });
    try {
      dynamicBus.emit('notify:publishFailed', {
        event,
        error: { message: err.message, name: err.name },
      });
    } catch {
      // Bus emission must never escalate the original error.
    }
    if (options.onPublishError) {
      try {
        const result = options.onPublishError({ event, payload, error: err });
        if (result instanceof Promise) {
          result.catch(retryErr => {
            logger.warn('onPublishError callback rejected', {
              event,
              err: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          });
        }
      } catch (callbackErr) {
        logger.warn('onPublishError callback threw', {
          event,
          err: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
        });
      }
    }
  }

  async function notify(input: NotifyInput): Promise<NotificationRecord | null> {
    if (input.actorId === input.userId && !input.allowSelfNotify) {
      return null;
    }

    const now = new Date();
    const requestedPriority = input.priority ?? 'normal';
    const isUrgent = requestedPriority === 'urgent';
    const preferences = await resolvePreferences(
      options.preferences,
      input.userId,
      options.source,
      input.type,
      options.defaultPreferences,
    );
    if (preferences.muted) {
      return null;
    }

    if (!isUrgent) {
      let allowed: boolean;
      try {
        allowed = await options.rateLimitBackend.check(
          `${options.source}:${input.userId}`,
          options.rateLimit.limit,
          options.rateLimit.windowMs,
        );
      } catch (err) {
        // P-NOTIF-9: a throwing backend is operationally distinct from a
        // hard `false` (the latter is an expected rate-limit block). Log
        // structured + emit `notify:rateLimit.error` so apps can alert; the
        // notification is dropped to fail closed.
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error('rate limit backend threw', {
          source: options.source,
          userId: input.userId,
          err: e.message,
        });
        metrics.counter('notifications.rateLimit.error', 1, { source: options.source });
        try {
          dynamicBus.emit('notify:rateLimit.error', {
            source: options.source,
            userId: input.userId,
            error: { message: e.message, name: e.name },
          });
        } catch {
          // Bus emission must never break notify().
        }
        return null;
      }
      if (!allowed) {
        return null;
      }
    }

    const priority: NotificationPriority = resolveEffectivePriority(
      requestedPriority,
      preferences,
      now,
    );

    const createInput: Record<string, unknown> = {
      userId: input.userId,
      tenantId: input.tenantId,
      source: options.source,
      type: input.type,
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      scopeId: input.scopeId,
      dedupKey: input.dedupKey,
      data: input.data == null ? undefined : freezeNotificationData(input.data),
      priority,
      deliverAt: input.deliverAt,
      dispatched: input.deliverAt == null,
      dispatchedAt: input.deliverAt == null ? now : undefined,
    };

    // Atomic dedup-or-create path. The adapter contract guarantees that
    // concurrent notify() calls for the same (userId, dedupKey) collapse to a
    // single notification — see NotificationAdapter.dedupOrCreate.
    if (!isUrgent && input.dedupKey) {
      const { record: notification, created } = await options.notifications.dedupOrCreate({
        userId: input.userId,
        dedupKey: input.dedupKey,
        create: createInput,
      });

      if (!created) {
        // Dedup hit — adapter returned an existing row and incremented its
        // count rather than creating a new one. No labels: dedupKeys are
        // intentionally application-defined and could include high-cardinality
        // values, so leaving the label off keeps the series count bounded.
        metrics.counter('notifications.dedup.hits');
        const nextCount = readCount(notification.data);
        const payload = {
          id: notification.id,
          userId: input.userId,
          tenantId: input.tenantId ?? null,
          changes: { count: nextCount },
        };
        try {
          options.events.publish('notifications:notification.updated', payload, {
            userId: input.userId,
            actorId: input.actorId ?? input.userId,
            source: 'system',
            requestTenantId: null,
          });
        } catch (err: unknown) {
          reportPublishError(
            'notifications:notification.updated',
            payload,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
        return notification;
      }

      if (input.deliverAt == null) {
        const payload: NotificationCreatedEventPayload = { notification, preferences };
        try {
          options.events.publish('notifications:notification.created', payload, {
            userId: notification.userId,
            actorId: notification.actorId ?? notification.userId,
            source: 'system',
            requestTenantId: null,
          });
        } catch (err: unknown) {
          reportPublishError(
            'notifications:notification.created',
            payload,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
      return notification;
    }

    const notification = await options.notifications.create(createInput);

    if (input.deliverAt == null) {
      const payload: NotificationCreatedEventPayload = {
        notification,
        preferences,
      };
      try {
        options.events.publish('notifications:notification.created', payload, {
          userId: notification.userId,
          actorId: notification.actorId ?? notification.userId,
          source: 'system',
          // System-source emit (called from notify() helper, not an HTTP route).
          // Notification's own tenantId is on the payload + scope, not here.
          requestTenantId: null,
        });
      } catch (err: unknown) {
        reportPublishError(
          'notifications:notification.created',
          payload,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    return notification;
  }

  return {
    /**
     * Create and dispatch a single notification. Respects preference
     * resolution (muted users are silently skipped), rate limits, and
     * dedup keys. Returns the created notification record, or `null` when
     * the notification was suppressed (muted, rate-limited, or self-notify
     * with `allowSelfNotify: false`).
     *
     * @example
     * ```ts
     * const notification = await builder.notify({
     *   userId: 'user-abc',
     *   type: 'comment:reply',
     *   targetType: 'post',
     *   targetId: 'post-42',
     *   data: { replyBody: 'Thanks!' },
     * });
     * // notification.id — the created record, or null if suppressed
     * ```
     */
    notify,
    /**
     * Create and dispatch notifications to multiple users. Each recipient
     * goes through the same preference and rate-limit logic as a single
     * `notify()` call. Returns an array of created notification records
     * (suppressed recipients are omitted).
     *
     * @example
     * ```ts
     * const results = await builder.notifyMany({
     *   userIds: ['user-abc', 'user-def'],
     *   type: 'announcement',
     *   data: { title: 'Server maintenance at 2am' },
     * });
     * console.log(`Delivered to ${results.length} users`);
     * ```
     */
    async notifyMany(input) {
      const uniqueUserIds = [...new Set(input.userIds)];
      const created: NotificationRecord[] = [];

      for (const userId of uniqueUserIds) {
        const notification = await notify({ ...input, userId });
        if (notification) {
          created.push(notification);
        }
      }

      return created;
    },
    /**
     * Schedule a notification for future delivery. The notification is
     * persisted immediately but will not be dispatched until the dispatcher
     * tick processes it after `deliverAt`. Returns the created notification
     * record. Throws if the notification was suppressed (muted or
     * rate-limited), because scheduling implies a delivery contract.
     *
     * @example
     * ```ts
     * const reminder = await builder.schedule({
     *   userId: 'user-abc',
     *   type: 'reminder',
     *   data: { task: 'Review PR #123' },
     *   deliverAt: new Date('2025-01-15T14:00:00Z'),
     * });
     * console.log(`Scheduled notification ${reminder.id}`);
     * ```
     */
    async schedule(input) {
      const notification = await notify(input);
      if (!notification) {
        throw new Error('[slingshot-notifications] Scheduled notification was suppressed');
      }
      return notification;
    },
    /**
     * Cancel a previously scheduled notification by deleting it. Safe to
     * call multiple times — a second delete on an already-cancelled or
     * dispatched notification resolves without error.
     *
     * @example
     * ```ts
     * await builder.cancel(notification.id);
     * // The notification is permanently removed from the store
     * ```
     */
    async cancel(notificationId) {
      await options.notifications.delete(notificationId);
    },
  };
}

export type { NotificationBuilder } from '@lastshotlabs/slingshot-core';

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
  readonly source: string;
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly bus: SlingshotEventBus;
  readonly events: SlingshotEvents;
  readonly rateLimitBackend: RateLimitBackend;
  readonly defaultPreferences: NotificationPreferenceDefaults;
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
  let publishFailureCount = 0;

  function reportPublishError(event: string, payload: unknown, err: Error): void {
    publishFailureCount += 1;
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
      let allowed = false;
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
          options.events.publish(
            'notifications:notification.updated',
            payload,
            {
              userId: input.userId,
              actorId: input.actorId ?? input.userId,
              source: 'system',
              requestTenantId: null,
            },
          );
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
    notify,
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
    async schedule(input) {
      const notification = await notify(input);
      if (!notification) {
        throw new Error('[slingshot-notifications] Scheduled notification was suppressed');
      }
      return notification;
    },
    async cancel(notificationId) {
      await options.notifications.delete(notificationId);
    },
  };
}

export type { NotificationBuilder } from '@lastshotlabs/slingshot-core';

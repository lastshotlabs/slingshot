import type {
  MetricsEmitter,
  NotificationBuilder,
  NotificationCreatedEventPayload,
  NotificationRecord,
  NotifyInput,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { createNoopMetricsEmitter } from '@lastshotlabs/slingshot-core';
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
      const allowed = await options.rateLimitBackend.check(
        `${options.source}:${input.userId}`,
        options.rateLimit.limit,
        options.rateLimit.windowMs,
      );
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
        try {
          options.events.publish(
            'notifications:notification.updated',
            {
              id: notification.id,
              userId: input.userId,
              tenantId: input.tenantId ?? null,
              changes: { count: nextCount },
            },
            {
              userId: input.userId,
              actorId: input.actorId ?? input.userId,
              source: 'system',
              requestTenantId: null,
            },
          );
        } catch (err: unknown) {
          console.error('[notifications] event publish error:', err);
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
          console.error('[notifications] event publish error:', err);
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
        console.error('[notifications] event publish error:', err);
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

import type {
  NotificationBuilder,
  NotificationCreatedEventPayload,
  NotificationRecord,
  NotifyInput,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
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

    if (!isUrgent && input.dedupKey) {
      const existing = await options.notifications.findByDedupKey({
        userId: input.userId,
        dedupKey: input.dedupKey,
      });
      if (existing && !existing.read) {
        const nextCount = readCount(existing.data) + 1;
        const updated = await options.notifications.update(existing.id, {
          data: freezeNotificationData({ ...(existing.data ?? {}), count: nextCount }),
        });
        if (updated) {
          options.events.publish(
            'notifications:notification.updated',
            {
              id: existing.id,
              userId: input.userId,
              tenantId: input.tenantId ?? null,
              changes: { count: nextCount },
            },
            {
              userId: input.userId,
              actorId: input.actorId ?? input.userId,
              source: 'system',
              // System-source emit (called from notify() helper, not an HTTP route).
              // Notification's own tenantId is on the payload + scope, not here.
              requestTenantId: null,
            },
          );
        }
        return updated;
      }
    }

    const priority: NotificationPriority = resolveEffectivePriority(
      requestedPriority,
      preferences,
      now,
    );

    const notification = await options.notifications.create({
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
    });

    if (input.deliverAt == null) {
      const payload: NotificationCreatedEventPayload = {
        notification,
        preferences,
      };
      options.events.publish('notifications:notification.created', payload, {
        userId: notification.userId,
        actorId: notification.actorId ?? notification.userId,
        source: 'system',
        // System-source emit (called from notify() helper, not an HTTP route).
        // Notification's own tenantId is on the payload + scope, not here.
        requestTenantId: null,
      });
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

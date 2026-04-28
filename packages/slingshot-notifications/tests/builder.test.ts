import { describe, expect, mock, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from '../src/builder';
import { createNoopRateLimitBackend } from '../src/rateLimit';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../src/testing';

describe('createNotificationBuilder', () => {
  test('uses configured default preferences when no preference rows exist', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let createdEvent:
      | {
          notification: { userId: string; type: string };
          preferences: { pushEnabled: boolean; emailEnabled: boolean; inAppEnabled: boolean };
        }
      | undefined;

    (
      bus as unknown as {
        on(event: string, handler: (payload: unknown) => void): void;
      }
    ).on('notifications:notification.created', payload => {
      createdEvent = payload as typeof createdEvent;
    });

    const builder = createNotificationBuilder({
      source: 'community',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: createNoopRateLimitBackend(),
      defaultPreferences: {
        pushEnabled: false,
        emailEnabled: true,
        inAppEnabled: false,
      },
      rateLimit: { limit: 100, windowMs: 60_000 },
    });

    await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
    });
    await bus.drain();

    expect(createdEvent?.preferences.pushEnabled).toBe(false);
    expect(createdEvent?.preferences.emailEnabled).toBe(true);
    expect(createdEvent?.preferences.inAppEnabled).toBe(false);
  });

  test('collapses unread duplicates by dedup key', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const first = await builder.notify({
      userId: 'user-1',
      type: 'community:reply',
      targetType: 'community:reply',
      targetId: 'reply-1',
      dedupKey: 'community:reply:thread-1:user-1',
      data: { count: 1 },
    });
    const second = await builder.notify({
      userId: 'user-1',
      type: 'community:reply',
      targetType: 'community:reply',
      targetId: 'reply-2',
      dedupKey: 'community:reply:thread-1:user-1',
      data: { count: 1 },
    });

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);

    const notifications = await adapters.notifications.listByUser({ 'actor.id': 'user-1' });
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0]?.data?.count).toBe(2);
  });

  test('urgent notifications bypass rate limiting and dedup collapse', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const builder = createNotificationBuilder({
      source: 'community',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: {
        check: async () => false,
      },
      defaultPreferences: {
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
      },
      rateLimit: { limit: 1, windowMs: 60_000 },
    });

    const first = await builder.notify({
      userId: 'user-1',
      type: 'community:reply',
      dedupKey: 'community:reply:thread-1:user-1',
      priority: 'urgent',
      data: { count: 1 },
    });
    const second = await builder.notify({
      userId: 'user-1',
      type: 'community:reply',
      dedupKey: 'community:reply:thread-1:user-1',
      priority: 'urgent',
      data: { count: 1 },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);

    const notifications = await adapters.notifications.listByUser({ 'actor.id': 'user-1' });
    expect(notifications.items).toHaveLength(2);
  });

  test('urgent notifications still respect muted preferences', async () => {
    const adapters = createNotificationsTestAdapters();
    await adapters.preferences.create({
      userId: 'user-1',
      scope: 'global',
      muted: true,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
    });

    const builder = adapters.createBuilder('community');
    const notification = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      priority: 'urgent',
    });

    expect(notification).toBeNull();
  });

  test('event publish failure does not propagate — notification is still returned', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();

    // Make events.publish throw for the created event
    const events = createNotificationsTestEvents(bus);
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('event bus unavailable');
      }
      return (originalPublish as (...a: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const errorSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = errorSpy;

    let notification: unknown;
    try {
      const builder = createNotificationBuilder({
        source: 'community',
        notifications: adapters.notifications,
        preferences: adapters.preferences,
        bus,
        events,
        rateLimitBackend: createNoopRateLimitBackend(),
        defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
        rateLimit: { limit: 100, windowMs: 60_000 },
      });

      notification = await builder.notify({
        userId: 'user-1',
        type: 'community:mention',
        targetType: 'community:post',
        targetId: 'post-1',
      });
    } finally {
      console.error = originalConsoleError;
    }

    // Notification was created despite the event publish failure
    expect(notification).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    expect(String((errorSpy.mock.calls[0] as string[])[0])).toContain('[notifications]');
  });

  test('dedup event publish failure does not propagate — deduplicated notification is still returned', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();

    // Make events.publish throw for the updated event (dedup path)
    const events = createNotificationsTestEvents(bus);
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.updated') {
        throw new Error('event bus down during dedup');
      }
      return (originalPublish as (...a: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const errorSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = errorSpy;

    let collapsed: unknown;
    try {
      const builder = createNotificationBuilder({
        source: 'community',
        notifications: adapters.notifications,
        preferences: adapters.preferences,
        bus,
        events,
        rateLimitBackend: createNoopRateLimitBackend(),
        defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
        rateLimit: { limit: 100, windowMs: 60_000 },
      });

      // First notify creates the notification
      await builder.notify({
        userId: 'user-1',
        type: 'community:mention',
        dedupKey: 'thread-dedup-publish-err',
      });

      // Second notify with same dedupKey triggers the dedup + updated event
      collapsed = await builder.notify({
        userId: 'user-1',
        type: 'community:mention',
        dedupKey: 'thread-dedup-publish-err',
      });
    } finally {
      console.error = originalConsoleError;
    }

    // Dedup returned the existing notification despite the event publish failure
    expect(collapsed).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    expect(String((errorSpy.mock.calls[0] as string[])[0])).toContain('[notifications]');
  });
});

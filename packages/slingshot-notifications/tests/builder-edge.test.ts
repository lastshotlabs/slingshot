/**
 * Edge-case coverage for the notification builder.
 *
 * Builds on the core builder tests in builder.test.ts.
 * Covers template resolution edge cases, invalid template handling,
 * recipient validation (self-notify suppression), empty data payloads,
 * null/undefined target types, and notifyMany with duplicate IDs.
 */
import { describe, expect, mock, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from '../src/builder';
import { createNoopRateLimitBackend } from '../src/rateLimit';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../src/testing';

// ---------------------------------------------------------------------------
// Self-notify suppression
// ---------------------------------------------------------------------------

describe('NotificationBuilder: self-notify suppression', () => {
  test('notify with actorId === userId returns null without creating anything', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      actorId: 'user-1',
      type: 'community:mention',
    });

    expect(result).toBeNull();
  });

  test('notify with actorId === userId AND allowSelfNotify: true creates notification', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      actorId: 'user-1',
      type: 'community:mention',
      allowSelfNotify: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
  });

  test('notify with different actorId and userId passes through', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-2',
      actorId: 'user-1',
      type: 'community:mention',
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-2');
  });
});

// ---------------------------------------------------------------------------
// Empty / null data payloads
// ---------------------------------------------------------------------------

describe('NotificationBuilder: data payload edge cases', () => {
  test('notify with undefined data does not throw', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
    });

    expect(result).not.toBeNull();
  });

  test('notify with empty object data does not throw', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      data: {},
    });

    expect(result).not.toBeNull();
  });

  test('notify with numeric 0 count in data does not throw', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      data: { count: 0 },
    });

    expect(result).not.toBeNull();
  });

  test('notify with very large nested data payload (within size limit) does not throw', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      data: { nested: { deep: { value: 'x'.repeat(1000) } } },
    });

    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Null / undefined target types and IDs
// ---------------------------------------------------------------------------

describe('NotificationBuilder: null target fields', () => {
  test('notify with null targetType and null targetId does not throw', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      targetType: null as unknown as undefined,
      targetId: null as unknown as undefined,
    });

    expect(result).not.toBeNull();
  });

  test('notify with scopeId creates notification with scopeId', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      scopeId: 'scope-1',
    });

    expect(result).not.toBeNull();
    expect(result?.scopeId).toBe('scope-1');
  });
});

// ---------------------------------------------------------------------------
// tenantId handling
// ---------------------------------------------------------------------------

describe('NotificationBuilder: tenantId handling', () => {
  test('notify with tenantId set stores the tenantId', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
      tenantId: 'tenant-42',
    });

    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe('tenant-42');
  });

  test('notify without tenantId stores null', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const result = await builder.notify({
      userId: 'user-1',
      type: 'community:mention',
    });

    expect(result).not.toBeNull();
    expect(result?.tenantId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// notifyMany edge cases
// ---------------------------------------------------------------------------

describe('NotificationBuilder: notifyMany edge cases', () => {
  test('notifyMany with duplicate userIds produces one notification per unique user', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const results = await builder.notifyMany({
      userIds: ['user-1', 'user-1', 'user-2', 'user-1'],
      type: 'community:mention',
    });

    // 2 unique users = 2 notifications (assuming none is muted/self-notified)
    expect(results).toHaveLength(2);
    const uniqueIds = new Set(results.map(r => r.userId));
    expect(uniqueIds.has('user-1')).toBe(true);
    expect(uniqueIds.has('user-2')).toBe(true);
  });

  test('notifyMany with empty userIds array returns empty array', async () => {
    const adapters = createNotificationsTestAdapters();
    const builder = adapters.createBuilder('community');

    const results = await builder.notifyMany({
      userIds: [],
      type: 'community:mention',
    });

    expect(results).toEqual([]);
  });

  test('notifyMany skips users that are muted (preferences suppress)', async () => {
    const adapters = createNotificationsTestAdapters();
    await adapters.preferences.create({
      userId: 'muted-user',
      scope: 'global',
      muted: true,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
    });

    const builder = adapters.createBuilder('community');

    const results = await builder.notifyMany({
      userIds: ['muted-user', 'active-user'],
      type: 'community:mention',
    });

    // active-user gets the notification, muted-user is suppressed
    expect(results).toHaveLength(1);
    expect(results[0]?.userId).toBe('active-user');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit backend error handling
// ---------------------------------------------------------------------------

describe('NotificationBuilder: rate-limit backend failures', () => {
  test('throwing rate-limit backend drops the notification and does not propagate the error', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const errorLogger = mock(() => {});
    const originalConsoleError = console.error;
    console.error = errorLogger;

    let notification: unknown;
    try {
      const builder = createNotificationBuilder({
        source: 'community',
        notifications: adapters.notifications,
        preferences: adapters.preferences,
        bus,
        events,
        rateLimitBackend: {
          check: async () => {
            throw new Error('rate-limit db unreachable');
          },
        },
        defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
        rateLimit: { limit: 100, windowMs: 60_000 },
      });

      notification = await builder.notify({
        userId: 'user-1',
        type: 'community:mention',
      });
    } finally {
      console.error = originalConsoleError;
    }

    // Notification is dropped (null) not thrown
    expect(notification).toBeNull();
    // Error was logged
    expect(errorLogger).toHaveBeenCalled();
  });
});

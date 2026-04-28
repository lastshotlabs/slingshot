import { describe, expect, test } from 'bun:test';
import { InProcessAdapter, getContext } from '@lastshotlabs/slingshot-core';
import { NOTIFICATIONS_PLUGIN_STATE_KEY } from '../src/state';
import type { NotificationsPluginState } from '../src/state';
import {
  createNotificationsTestAdapters,
  createNotificationsTestBootstrap,
  createNotificationsTestEvents,
} from '../src/testing';

describe('notifications testing helpers', () => {
  test('wraps memory notification adapters with the package adapter contract', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date();
    const dueAt = new Date(now.getTime() - 1_000);
    const futureAt = new Date(now.getTime() + 60_000);

    const first = await adapters.notifications.create({
      userId: 'user-1',
      tenantId: 'tenant-1',
      source: 'community',
      type: 'community:mention',
      actorId: 'actor-1',
      targetType: 'thread',
      targetId: 'thread-1',
      dedupKey: 'dedup-1',
      data: { count: 1 },
      deliverAt: dueAt,
      scopeId: 'thread-1',
      priority: 'high',
    });
    const second = await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:reply',
      deliverAt: dueAt,
      scopeId: 'thread-2',
    });
    const future = await adapters.notifications.create({
      userId: 'user-1',
      source: 'billing',
      type: 'billing:invoice',
      dedupKey: 'dedup-2',
      deliverAt: futureAt,
    });

    expect(first.tenantId).toBe('tenant-1');
    expect(first.actorId).toBe('actor-1');
    expect(first.priority).toBe('high');
    expect(first.data?.count).toBe(1);

    await expect(adapters.notifications.getById(first.id)).resolves.toMatchObject({
      id: first.id,
      userId: 'user-1',
    });
    await expect(adapters.notifications.list()).resolves.toMatchObject({
      hasMore: false,
    });
    await expect(adapters.notifications.listByUser({ userId: 'user-1' })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: first.id })]),
    });
    await expect(adapters.notifications.listUnread({ userId: 'user-1' })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ]),
    });
    await expect(adapters.notifications.unreadCount({ userId: 'user-1' })).resolves.toEqual({
      count: 3,
    });
    await expect(
      adapters.notifications.unreadCountBySource({ userId: 'user-1', source: 'community' }),
    ).resolves.toEqual({ count: 2 });
    await expect(
      adapters.notifications.unreadCountByScope({
        userId: 'user-1',
        source: 'community',
        scopeId: 'thread-1',
      }),
    ).resolves.toEqual({ count: 1 });
    await expect(
      adapters.notifications.hasUnreadByDedupKey({ userId: 'user-1', dedupKey: 'dedup-1' }),
    ).resolves.toBe(true);
    await expect(
      adapters.notifications.findByDedupKey({ userId: 'user-1', dedupKey: 'dedup-1' }),
    ).resolves.toMatchObject({ id: first.id });

    const pending = await adapters.notifications.listPendingDispatch({ limit: 10, now });
    expect(pending.map(item => item.id).sort()).toEqual([first.id, second.id].sort());

    await adapters.notifications.markDispatched({ id: first.id, dispatchedAt: now });
    await expect(adapters.notifications.getById(first.id)).resolves.toMatchObject({
      dispatched: true,
    });

    await expect(
      adapters.notifications.markRead({ id: first.id, userId: 'user-1' }),
    ).resolves.toMatchObject({ read: true });
    await expect(
      adapters.notifications.hasUnreadByDedupKey({ userId: 'user-1', dedupKey: 'dedup-1' }),
    ).resolves.toBe(false);

    await expect(
      adapters.notifications.update(future.id, { data: { status: 'changed' } }),
    ).resolves.toMatchObject({ data: { status: 'changed' } });
    await expect(adapters.notifications.markAllRead({ userId: 'user-1' })).resolves.toBe(2);
    await expect(adapters.notifications.listUnread({ userId: 'user-1' })).resolves.toMatchObject({
      items: [],
    });

    await expect(adapters.notifications.delete(future.id)).resolves.toBe(true);
    await expect(adapters.notifications.getById(future.id)).resolves.toBeNull();
    await adapters.clear();
    await expect(adapters.notifications.list()).resolves.toMatchObject({ items: [] });
  });

  test('wraps memory preference adapters with preference resolution helpers', async () => {
    const adapters = createNotificationsTestAdapters();

    const global = await adapters.preferences.create({
      userId: 'user-1',
      tenantId: 'tenant-1',
      scope: 'global',
      muted: true,
      pushEnabled: false,
      emailEnabled: true,
      inAppEnabled: false,
      quietStart: '22:00',
      quietEnd: '06:00',
    });
    const source = await adapters.preferences.create({
      userId: 'user-1',
      scope: 'source',
      source: 'community',
    });

    expect(global).toMatchObject({
      tenantId: 'tenant-1',
      scope: 'global',
      muted: true,
      pushEnabled: false,
      emailEnabled: true,
      inAppEnabled: false,
    });
    expect(source).toMatchObject({
      scope: 'source',
      source: 'community',
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
    });
    await expect(adapters.preferences.getById(global.id)).resolves.toMatchObject({
      id: global.id,
    });
    await expect(adapters.preferences.list()).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: global.id })]),
    });
    await expect(adapters.preferences.listByUser({ userId: 'user-1' })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: source.id })]),
    });
    await expect(
      adapters.preferences.resolveForNotification({ userId: 'user-1' }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: global.id })]));

    await expect(
      adapters.preferences.update(global.id, { muted: false, quietEnd: '07:00' }),
    ).resolves.toMatchObject({ muted: false, quietEnd: '07:00' });
    await expect(adapters.preferences.delete(source.id)).resolves.toBe(true);
    await expect(adapters.preferences.getById(source.id)).resolves.toBeNull();
  });

  test('registers event definitions and resolves notification event scopes', () => {
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    expect(
      events
        .list()
        .map(definition => definition.key)
        .sort(),
    ).toEqual([
      'notifications:notification.created',
      'notifications:notification.read',
      'notifications:notification.updated',
    ]);

    const ctx = { requestTenantId: null, source: 'system' as const };
    const created = events.publish(
      'notifications:notification.created',
      {
        notification: {
          id: 'notification-1',
          userId: 'user-1',
          tenantId: 'tenant-1',
          actorId: 'actor-1',
          source: 'test',
          type: 'test:event',
          read: false,
          dispatched: false,
          priority: 'normal',
          createdAt: new Date(),
        },
        preferences: {
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
        },
      },
      ctx,
    );
    const updated = events.publish(
      'notifications:notification.updated',
      { id: 'notification-1', userId: 'user-1', tenantId: 'tenant-1' },
      ctx,
    );
    const read = events.publish(
      'notifications:notification.read',
      { id: 'notification-1', userId: 'user-1', tenantId: 'tenant-1' },
      ctx,
    );

    expect(created.meta.scope).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      actorId: 'actor-1',
    });
    expect(updated.meta.scope).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      actorId: 'user-1',
    });
    expect(read.meta.scope).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      actorId: 'user-1',
    });
  });

  test('creates a bootstrap runtime with context state and builder helpers', async () => {
    const bootstrap = createNotificationsTestBootstrap();
    const ctx = getContext(bootstrap.app);
    const state = ctx.pluginState.get(NOTIFICATIONS_PLUGIN_STATE_KEY) as NotificationsPluginState;

    expect(ctx.bus).toBe(bootstrap.bus);
    expect(state.config.mountPath).toBe('/notifications');
    expect(state.config.sseEnabled).toBe(true);
    expect(await state.dispatcher.tick()).toBe(0);
    state.dispatcher.start();
    state.dispatcher.stop();
    state.registerDeliveryAdapter({
      async deliver() {},
    });

    const defaultSource = await bootstrap.builder.notify({
      userId: 'user-1',
      type: 'test:event',
    });
    const customSource = await bootstrap.createBuilder('alerts').notify({
      userId: 'user-1',
      type: 'alerts:event',
    });

    expect(defaultSource?.source).toBe('test');
    expect(customSource?.source).toBe('alerts');
    await bootstrap.clear();
    await expect(bootstrap.notifications.listByUser({ userId: 'user-1' })).resolves.toMatchObject({
      items: [],
    });
  });
});

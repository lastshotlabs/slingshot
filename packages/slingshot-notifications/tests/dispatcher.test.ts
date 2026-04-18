import { describe, expect, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../src/dispatcher';
import { createNotificationsTestAdapters } from '../src/testing';

describe('createIntervalDispatcher', () => {
  test('resolves stored preferences before emitting scheduled notifications', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    let createdEvent:
      | {
          notification: { id: string; userId: string };
          preferences: { pushEnabled: boolean };
        }
      | undefined;

    (
      bus as unknown as {
        on(event: string, handler: (payload: unknown) => void): void;
      }
    ).on('notifications:notification.created', payload => {
      createdEvent = payload as typeof createdEvent;
    });

    await adapters.preferences.create({
      userId: 'user-1',
      scope: 'source',
      source: 'community',
      muted: false,
      pushEnabled: false,
      emailEnabled: true,
      inAppEnabled: true,
    });

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      userId: 'user-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
      deliverAt: new Date(Date.now() - 1_000),
    });

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    const dispatched = await dispatcher.tick();
    await bus.drain();

    expect(dispatched).toBe(1);
    expect(createdEvent?.notification.id).toBe(notification.id);
    expect(createdEvent?.preferences.pushEnabled).toBe(false);

    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(true);
    expect(persisted?.dispatchedAt).toBeTruthy();
  });
});

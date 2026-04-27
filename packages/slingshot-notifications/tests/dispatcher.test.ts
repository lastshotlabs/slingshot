import { describe, expect, mock, spyOn, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../src/dispatcher';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../src/testing';

describe('createIntervalDispatcher', () => {
  test('resolves stored preferences before emitting scheduled notifications', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
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
      events,
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

  test('rolls back dispatched state when publish fails after marking the row', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalPublish = events.publish.bind(events);
    events.publish = (key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('publish failed');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    };

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
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    const dispatched = await dispatcher.tick();
    await bus.drain();

    expect(dispatched).toBe(0);
    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(false);
    expect(persisted?.dispatchedAt).toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('logs dispatcher tick failures instead of surfacing unhandled rejections', async () => {
    const adapters = createNotificationsTestAdapters();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const tick = mock(async () => {
      throw new Error('dispatcher boom');
    });
    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus: new InProcessAdapter(),
      events: createNotificationsTestEvents(new InProcessAdapter()),
      intervalMs: 1_000,
      maxPerTick: 10,
    });
    (dispatcher as { tick: typeof tick }).tick = tick;
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') {
        void handler();
      }
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    dispatcher.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('stop() returns a promise that resolves after in-flight tick completes', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let releaseTick!: () => void;
    const tickBlocked = new Promise<void>(resolve => {
      releaseTick = resolve;
    });
    const listPendingDispatch = mock(async () => {
      await tickBlocked;
      return [];
    });
    (
      adapters.notifications as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') void handler();
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    dispatcher.start();
    await Promise.resolve();

    const stopPromise = dispatcher.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseTick();
    await stopPromise;
    expect(stopped).toBe(true);

    setIntervalSpy.mockRestore();
  });

  test('start() is idempotent — double start creates only one interval', () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1) as typeof setInterval,
    );

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    dispatcher.start();
    dispatcher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  test('stop() is safe when the dispatcher was never started', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    await expect(dispatcher.stop()).resolves.toBeUndefined();
  });

  test('processes only maxPerTick rows when the adapter over-returns pending notifications', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const oversizeRows = Array.from({ length: 5 }, (_, i) => ({
      id: `n-${i}`,
      userId: 'user-1',
      actorId: null,
      source: 'community',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
      tenantId: null,
      data: null,
      read: false,
      dispatched: false,
      dispatchedAt: null,
      scheduledAt: new Date(),
      createdAt: new Date(),
    }));

    const listPendingDispatch = mock(async () => oversizeRows);
    (
      adapters.notifications as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 1,
    });

    await dispatcher.tick();

    expect(listPendingDispatch).toHaveBeenCalledTimes(1);
  });

  test('does not re-enter while a dispatcher tick is already running', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let releaseTick!: () => void;
    const tickBlocked = new Promise<void>(resolve => {
      releaseTick = resolve;
    });
    const listPendingDispatch = mock(async () => {
      await tickBlocked;
      return [];
    });
    (
      adapters.notifications as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
    });

    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') {
        void handler();
        void handler();
      }
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    dispatcher.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(listPendingDispatch).toHaveBeenCalledTimes(1);

    releaseTick();
    await Promise.resolve();
    await Promise.resolve();

    dispatcher.stop();
    setIntervalSpy.mockRestore();
  });
});

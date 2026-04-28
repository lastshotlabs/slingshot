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
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('publish failed');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

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
    (dispatcher as unknown as { tick: typeof tick }).tick = tick;
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') {
        void handler();
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

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
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
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
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

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
      (() => 1) as unknown as typeof setInterval,
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
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
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

  test('stop() times out and logs warning when inflight tick does not settle', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    let capturedSignal: AbortSignal | undefined;
    // A tick that never resolves unless the dispatcher aborts it.
    const listPendingDispatch = mock((params: { signal?: AbortSignal }) => {
      capturedSignal = params.signal;
      return new Promise<never>(() => {});
    });
    (
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
      stopTimeoutMs: 10, // very short timeout to keep test fast
    });

    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') void handler();
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    dispatcher.start();
    await Promise.resolve();

    // stop() should resolve (via timeout) instead of hanging
    await expect(dispatcher.stop()).resolves.toBeUndefined();

    // The timeout error is caught and logged
    expect(errorSpy).toHaveBeenCalled();
    const logMsg = errorSpy.mock.calls[0]?.[0] as string;
    expect(logMsg).toContain('did not settle');
    expect(capturedSignal?.aborted).toBe(true);

    setIntervalSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('does not publish work after stop() is called mid-tick (provider settles after stop)', async () => {
    // Reproduces the audit's "fire-after-stop" race: a tick is in flight
    // (its provider promise is pending) when stop() is called. The provider
    // promise then settles successfully. The dispatcher must NOT publish
    // any new events or roll back work it never tried — `stopped` must
    // short-circuit at the next async hop.
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    // Pre-create a row so listPendingDispatch can return it.
    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      userId: 'user-late',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-late',
      deliverAt: new Date(Date.now() - 1_000),
    });

    // Track every publish so we can assert nothing fires post-stop.
    const publishedIds: string[] = [];
    (
      bus as unknown as {
        on(event: string, handler: (payload: unknown) => void): void;
      }
    ).on('notifications:notification.created', payload => {
      const row = (payload as { notification: { id: string } }).notification;
      publishedIds.push(row.id);
    });

    let releaseList: (() => void) | undefined;
    const listGate = new Promise<void>(resolve => {
      releaseList = resolve;
    });
    const originalList = adapters.notifications.listPendingDispatch.bind(adapters.notifications);
    (
      adapters.notifications as unknown as {
        listPendingDispatch: typeof adapters.notifications.listPendingDispatch;
      }
    ).listPendingDispatch = (async params => {
      // Block here so stop() can flip `stopped` while the tick is mid-flight.
      await listGate;
      return originalList(params);
    }) as typeof adapters.notifications.listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 60_000,
      maxPerTick: 10,
      stopTimeoutMs: 1_000,
    });

    // Kick off the tick directly so we don't depend on the interval timer.
    const tickPromise = dispatcher.tick();

    // Yield once so the tick lands inside the gated listPendingDispatch.
    await Promise.resolve();

    // Stop the dispatcher while the tick is still mid-flight.
    const stopPromise = dispatcher.stop();

    // Now release the listPendingDispatch promise so the tick body resumes.
    // The post-await `if (stopped) return 0;` should skip the publish loop.
    releaseList?.();

    await tickPromise;
    await stopPromise;
    await bus.drain();

    expect(publishedIds).toHaveLength(0);

    // Sanity: the row was never marked dispatched in the post-stop path.
    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(false);
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
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
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
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

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

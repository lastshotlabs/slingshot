/**
 * Failure-mode coverage for the polling dispatcher: provider throws, transient
 * vs persistent failures, retry/backoff, the maxDelayMs clamp, and the
 * consecutive-failure circuit breaker. Mirrors the patterns established for
 * the push router (see slingshot-push/src/router.ts).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../../src/dispatcher';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../../src/testing';

const SCHEDULE_BASE = {
  type: 'community:mention',
  targetType: 'community:thread',
  targetId: 'thread-1',
} as const;

function inThePast(): Date {
  return new Date(Date.now() - 1_000);
}

describe('createIntervalDispatcher — provider failure handling', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('publish throws → notification stays unsent and is retried on next tick', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-1',
      deliverAt: inThePast(),
    });

    let throwCount = 0;
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created' && throwCount === 0) {
        throwCount += 1;
        throw new Error('provider transient failure');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      // Single attempt so the first failure rolls back without retrying the
      // same row mid-tick.
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      breaker: { threshold: 100 },
    });

    // First tick: provider throws, row rolls back to undispatched.
    expect(await dispatcher.tick()).toBe(0);
    let persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(false);
    expect(persisted?.dispatchedAt).toBeNull();

    // Second tick: provider succeeds, row is now dispatched.
    expect(await dispatcher.tick()).toBe(1);
    persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(true);
    expect(persisted?.dispatchedAt).toBeTruthy();
  });

  test('transient failure within retry budget eventually publishes in same tick', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-2',
      deliverAt: inThePast(),
    });

    let attempts = 0;
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        attempts += 1;
        if (attempts < 3) throw new Error('try again');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 100 },
    });

    expect(await dispatcher.tick()).toBe(1);
    expect(attempts).toBe(3);
    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(true);
  });

  test('exhausting retries within a tick rolls back the dispatched flag', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-3',
      deliverAt: inThePast(),
    });

    let attempts = 0;
    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        attempts += 1;
        throw new Error('persistent provider failure');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 100 },
    });

    expect(await dispatcher.tick()).toBe(0);
    expect(attempts).toBe(4);
    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(false);
    expect(persisted?.dispatchedAt).toBeNull();
  });
});

describe('createIntervalDispatcher — circuit breaker', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('repeated failures to one destination trip the breaker and short-circuit further sends in the same tick', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    // Schedule three notifications for the same user — once the breaker
    // trips on the first row, the next two should be skipped without ever
    // calling publish.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await builder.schedule({
        ...SCHEDULE_BASE,
        userId: 'user-tripper',
        deliverAt: inThePast(),
      });
      ids.push(n.id);
    }

    let publishCalls = 0;
    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        publishCalls += 1;
        throw new Error('boom');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      // First row exhausts the threshold (3 attempts === threshold), tripping
      // the breaker before the next two rows are processed.
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 3, cooldownMs: 60_000 },
    });

    expect(await dispatcher.tick()).toBe(0);

    // Only the first row's 3 retry attempts should have hit publish — the
    // breaker should have skipped the remaining rows.
    expect(publishCalls).toBe(3);

    // All three rows should remain undispatched.
    for (const id of ids) {
      const persisted = await adapters.notifications.getById(id);
      expect(persisted?.dispatched).toBe(false);
    }
  });

  test('breaker cooldown — subsequent ticks within cooldown skip the destination', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-cooldown',
      deliverAt: inThePast(),
    });

    let publishCalls = 0;
    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        publishCalls += 1;
        throw new Error('boom');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    let fakeNow = 1_000_000;
    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 2, cooldownMs: 30_000 },
      now: () => fakeNow,
    });

    // Tick 1 — trips the breaker.
    expect(await dispatcher.tick()).toBe(0);
    expect(publishCalls).toBe(2);

    // Tick 2 — within cooldown, breaker stays open, publish is not called.
    fakeNow += 1_000;
    expect(await dispatcher.tick()).toBe(0);
    expect(publishCalls).toBe(2);

    // Tick 3 — past cooldown, breaker enters half-open and the probe runs
    // (one more publish call before failing again).
    fakeNow += 60_000;
    expect(await dispatcher.tick()).toBe(0);
    expect(publishCalls).toBeGreaterThan(2);
  });

  test('successful publish resets the consecutive-failure counter for that destination', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const a = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-resilient',
      deliverAt: inThePast(),
    });
    const b = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-resilient',
      deliverAt: inThePast(),
    });

    let publishCalls = 0;
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        publishCalls += 1;
        // First publish (for `a`) fails twice then succeeds via retry.
        // Second publish (for `b`) succeeds first try because the breaker
        // counter was reset on a's success.
        if (publishCalls === 1) throw new Error('flap');
        if (publishCalls === 2) throw new Error('flap');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 5 },
      // Threshold of 3 — without a reset the third failure across the two
      // notifications would trip the breaker.
      breaker: { threshold: 3, cooldownMs: 60_000 },
    });

    expect(await dispatcher.tick()).toBe(2);
    const persistedA = await adapters.notifications.getById(a.id);
    const persistedB = await adapters.notifications.getById(b.id);
    expect(persistedA?.dispatched).toBe(true);
    expect(persistedB?.dispatched).toBe(true);
  });
});

describe('createIntervalDispatcher — retry delay clamp (maxDelayMs)', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('exponential backoff is clamped to maxDelayMs across attempts', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-clamp',
      deliverAt: inThePast(),
    });

    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('always fail');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    const observedDelays: number[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
    ) => {
      if (typeof delay === 'number' && delay > 0) {
        observedDelays.push(delay);
      }
      // Run handler immediately so retries don't actually wait — the delay
      // values are what we care about asserting on.
      if (typeof handler === 'function') handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const initialDelayMs = 1_000;
    const maxDelayMs = 1_500;
    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 5, initialDelayMs, maxDelayMs },
      breaker: { threshold: 100 },
    });

    await dispatcher.tick();

    expect(observedDelays.length).toBeGreaterThan(0);
    // Every observed delay must respect the clamp; without it, exponential
    // backoff at attempt 5 would be 16_000ms.
    for (const d of observedDelays) {
      expect(d).toBeLessThanOrEqual(maxDelayMs);
    }
    // First retry delay equals initialDelayMs (no exponential growth yet).
    expect(observedDelays[0]).toBe(initialDelayMs);
    // A later retry must be the clamped value, not the unclamped exponential.
    expect(observedDelays[observedDelays.length - 1]).toBe(maxDelayMs);

    setTimeoutSpy.mockRestore();
  });
});

describe('createIntervalDispatcher — breaker independence', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('breaker is keyed per destination — failures for user A do not affect user B', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const aNotif = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-A',
      deliverAt: inThePast(),
    });
    const bNotif = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-B',
      deliverAt: inThePast(),
    });

    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, payload: unknown, ...rest: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        const eventPayload = payload as { notification: { userId: string } };
        if (eventPayload.notification.userId === 'user-A') {
          throw new Error('user-A always fails');
        }
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, payload, ...rest);
    }) as typeof events.publish;

    // Make the listPendingDispatch return a stable order so user-A is first.
    const originalList = adapters.notifications.listPendingDispatch.bind(adapters.notifications);
    adapters.notifications.listPendingDispatch = mock(async params => {
      const result = await originalList(params);
      return {
        records: result.records.sort((l, r) => (l.userId < r.userId ? -1 : 1)),
        nextCursor: result.nextCursor,
      };
    }) as typeof adapters.notifications.listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 2, cooldownMs: 60_000 },
    });

    expect(await dispatcher.tick()).toBe(1);

    const persistedA = await adapters.notifications.getById(aNotif.id);
    const persistedB = await adapters.notifications.getById(bNotif.id);
    expect(persistedA?.dispatched).toBe(false);
    expect(persistedB?.dispatched).toBe(true);
  });
});

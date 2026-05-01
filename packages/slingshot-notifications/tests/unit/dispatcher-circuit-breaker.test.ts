/**
 * Dedicated circuit-breaker tests for the polling dispatcher.
 *
 * Coverage boundaries:
 * - Per-destination state tracking (separate breaker per userId)
 * - Trip threshold: N consecutive failures opens the breaker
 * - Open state: further sends to the destination are skipped
 * - Half-open probe: after cooldown, a single publish attempt is allowed
 * - Reset on success: a successful publish clears the failure count
 * - getHealth() surfaces openBreakerCount after trips and resets
 * - Mixed destinations: breaker for failing user does not affect other users
 * - Breaker state survives across ticks (cooldown crosses tick boundaries)
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

describe('createIntervalDispatcher — circuit breaker openBreakerCount', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('getHealth().openBreakerCount is 0 before any tick', () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      breaker: { threshold: 2, cooldownMs: 60_000 },
    });

    expect(dispatcher.getHealth().openBreakerCount).toBe(0);
  });

  test('openBreakerCount increments when breaker trips and decrements after cooldown', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;

    // Create notifications for a single destination that always fails.
    const builder = adapters.createBuilder('community');
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-flaky',
      deliverAt: inThePast(),
    });

    events.publish = (() => {
      throw new Error('always fail');
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 2, cooldownMs: 60_000 },
      now: () => fakeNow,
    });

    // Tick 1: trip the breaker (2 consecutive failures = threshold 2).
    await dispatcher.tick();
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    // Tick 2: still within cooldown — breaker stays open.
    fakeNow += 1_000;
    await dispatcher.tick();
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    // Advance past cooldown. The breaker transitions to half-open; the probe
    // will attempt a publish (which fails again), re-tripping the breaker.
    fakeNow += 60_001;
    await dispatcher.tick();
    // After the probe fails, the breaker is re-tripped with a new cooldown.
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    await dispatcher.stop();
  });

  test('openBreakerCount reports zero when all breakers reset on success', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-resilient',
      deliverAt: inThePast(),
    });

    let callCount = 0;
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        callCount += 1;
        // Fail twice to trip the breaker, then succeed on the third call
        // (which happens on a second tick after cooldown).
        if (callCount <= 2) throw new Error('flap');
      }
      return (originalPublish as (...p: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 2, cooldownMs: 10_000 },
      now: () => fakeNow,
    });

    // Tick 1: two failures trip the breaker.
    await dispatcher.tick();
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);
    expect(callCount).toBe(2);

    // Advance past cooldown for the half-open probe.
    fakeNow += 10_001;
    // On tick 2, the half-open probe publishes (callCount 3 succeeds).
    await dispatcher.tick();
    // Success resets the breaker.
    expect(dispatcher.getHealth().openBreakerCount).toBe(0);

    // Verify the notification was actually dispatched.
    const persisted = await adapters.notifications.getById(notification.id);
    expect(persisted?.dispatched).toBe(true);

    await dispatcher.stop();
  });

  test('openBreakerCount correctly sums multiple open breakers', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;

    const builder = adapters.createBuilder('community');
    const notificationA = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-A',
      deliverAt: inThePast(),
    });
    const notificationB = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-B',
      deliverAt: inThePast(),
    });
    void notificationA;
    void notificationB;

    events.publish = (() => {
      throw new Error('always fail');
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      breaker: { threshold: 2, cooldownMs: 60_000 },
      now: () => fakeNow,
    });

    // Tick 1: trip breaker for user-A and user-B (2 failures each).
    await dispatcher.tick();
    expect(dispatcher.getHealth().openBreakerCount).toBe(2);

    // Advance past cooldown.
    fakeNow += 60_001;
    await dispatcher.tick();

    // After the half-open probe fails, breakers are re-tripped
    // (still 2 open breakers).
    expect(dispatcher.getHealth().openBreakerCount).toBe(2);

    await dispatcher.stop();
  });

  test('breaker does not interfere with second destination when first is broken', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');

    // user-BAD always fails; user-GOOD should succeed.
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-BAD',
      deliverAt: inThePast(),
    });
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-GOOD',
      deliverAt: inThePast(),
    });

    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, payload: unknown, ...rest: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        const eventPayload = payload as { notification: { userId: string } };
        if (eventPayload.notification.userId === 'user-BAD') {
          throw new Error('bad user always fails');
        }
      }
      return (originalPublish as (...p: unknown[]) => unknown)(key, payload, ...rest);
    }) as typeof events.publish;

    // Ensure listPendingDispatch returns user-BAD first.
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

    // user-BAD trips breaker after 2 attempts; user-GOOD succeeds on first publish.
    const dispatched = await dispatcher.tick();
    expect(dispatched).toBe(1);
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    await dispatcher.stop();
  });
});

describe('createIntervalDispatcher — breaker half-open probe behavior', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('half-open probe on cooldown expiry allows one publish attempt', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;
    let publishCalls = 0;

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-probe',
      deliverAt: inThePast(),
    });

    events.publish = (() => {
      publishCalls += 1;
      throw new Error('always fail');
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
      // threshold=1 so each tick's single attempt trips the breaker immediately.
      breaker: { threshold: 1, cooldownMs: 30_000 },
      now: () => fakeNow,
    });

    // Tick 1: trip breaker (1 attempt = threshold 1).
    await dispatcher.tick();
    expect(publishCalls).toBe(1);

    // Advance past cooldown — breaker enters half-open.
    fakeNow += 30_001;
    publishCalls = 0; // reset counter for clarity

    // Tick 2: half-open probe should attempt publish exactly once.
    await dispatcher.tick();
    // The probe fails, re-tripping the breaker.
    expect(publishCalls).toBe(1);
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    await dispatcher.stop();
  });

  test('half-open probe succeeds — breaker resets and subsequent publishes proceed', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;
    let failCount = 0;

    // Schedule 2 notifications: one to trip, one to benefit from the reset.
    const builder = adapters.createBuilder('community');
    const notifA = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-halfopen',
      deliverAt: inThePast(),
    });
    const notifB = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-halfopen',
      deliverAt: inThePast(),
    });
    void notifA;
    void notifB;

    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        failCount += 1;
        // Only fail the first call (first row, first attempt).
        // The half-open probe and second notification will succeed.
        if (failCount === 1) throw new Error('first failure');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
      // threshold=1 so first failure trips immediately.
      breaker: { threshold: 1, cooldownMs: 30_000 },
      now: () => fakeNow,
    });

    // Tick 1: first row fails (trips breaker), second row is short-circuited.
    await dispatcher.tick();
    expect(dispatcher.getHealth().openBreakerCount).toBe(1);

    // Advance past cooldown.
    fakeNow += 30_001;

    // Tick 2: half-open probe on first remaining row succeeds, breaker resets.
    // The second remaining row should then also be processed.
    const dispatched = await dispatcher.tick();
    expect(dispatched).toBe(2);
    expect(dispatcher.getHealth().openBreakerCount).toBe(0);

    await dispatcher.stop();
  });

  test('consecutive failures reset to 0 on success even if cooldown never tripped', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    // Create 2 notifications — first fails, second succeeds.
    const notifA = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-reset',
      deliverAt: inThePast(),
    });
    const notifB = await builder.schedule({
      ...SCHEDULE_BASE,
      userId: 'user-reset',
      deliverAt: inThePast(),
    });
    void notifA;
    void notifB;

    let callCount = 0;
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown) => {
      if (String(key) === 'notifications:notification.created') {
        callCount += 1;
        if (callCount === 1) throw new Error('first fails');
      }
      return undefined;
    }) as unknown as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
      // threshold high enough that the first failure does NOT trip the breaker
      breaker: { threshold: 5, cooldownMs: 60_000 },
    });

    // Both rows should be processed: first fails, second succeeds.
    const dispatched = await dispatcher.tick();
    // 1 success (second row)
    expect(dispatched).toBe(1);
    // Breaker never tripped
    expect(dispatcher.getHealth().openBreakerCount).toBe(0);

    await dispatcher.stop();
  });
});

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../../src/dispatcher';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../../src/testing';

describe('dispatcher backpressure', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('exposes pendingCount via getHealth() before and after first tick', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const countPendingDispatch = mock(async () => 7);
    (
      adapters.notifications as unknown as {
        countPendingDispatch: typeof countPendingDispatch;
      }
    ).countPendingDispatch = countPendingDispatch;

    const listPendingDispatch = mock(async () => []);
    (
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 100,
    });

    expect(dispatcher.getHealth().pendingCount).toBeNull();
    expect(dispatcher.getHealth().lastTickAt).toBeNull();

    await dispatcher.tick();

    const health = dispatcher.getHealth();
    expect(health.pendingCount).toBe(7);
    expect(health.pendingCountIsLowerBound).toBe(false);
    expect(health.lastDispatchedCount).toBe(0);
    expect(health.lastTickAt).not.toBeNull();
    expect(countPendingDispatch).toHaveBeenCalledTimes(1);
  });

  test('emits pending-saturation warning at most once per minute even across many ticks', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    let nowMs = 1_000_000;

    const countPendingDispatch = mock(async () => 100_000);
    (
      adapters.notifications as unknown as {
        countPendingDispatch: typeof countPendingDispatch;
      }
    ).countPendingDispatch = countPendingDispatch;

    const listPendingDispatch = mock(async () => []);
    (
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 500,
      maxPendingBeforeAlarm: 50_000,
      pendingAlarmThrottleMs: 60_000,
      now: () => nowMs,
    });

    // Run 5 ticks within the same minute — only one warning should fire.
    for (let i = 0; i < 5; i += 1) {
      nowMs += 1_000;
      await dispatcher.tick();
    }

    const saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    expect(saturationCalls.length).toBe(1);
    expect(dispatcher.getHealth().pendingAlarmActive).toBe(true);

    // Advance past the throttle window and run another tick — the warning
    // fires once more for the new window.
    nowMs += 60_001;
    await dispatcher.tick();

    const afterRollOver = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    expect(afterRollOver.length).toBe(2);
  });

  test('falls back to listed-row count when adapter has no countPendingDispatch', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    // Ensure the optional method is absent.
    delete (
      adapters.notifications as unknown as {
        countPendingDispatch?: () => Promise<number>;
      }
    ).countPendingDispatch;

    const oversizeRows = Array.from({ length: 5 }, (_, i) => ({
      id: `n-${i}`,
      userId: `user-${i}`,
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

    let nowMs = 1_000_000;
    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      // maxPerTick equals row count so listing is at saturation
      maxPerTick: 5,
      // Threshold low enough that the lower-bound count crosses it
      maxPendingBeforeAlarm: 5,
      pendingAlarmThrottleMs: 60_000,
      now: () => nowMs,
    });

    await dispatcher.tick();

    const health = dispatcher.getHealth();
    expect(health.pendingCount).toBe(5);
    expect(health.pendingCountIsLowerBound).toBe(true);

    const saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    expect(saturationCalls.length).toBe(1);
    expect(String(saturationCalls[0]?.[0])).toContain('lower bound');
  });

  test('maxPendingBeforeAlarm=0 disables the warning entirely', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const countPendingDispatch = mock(async () => 1_000_000);
    (
      adapters.notifications as unknown as {
        countPendingDispatch: typeof countPendingDispatch;
      }
    ).countPendingDispatch = countPendingDispatch;

    const listPendingDispatch = mock(async () => []);
    (
      adapters.notifications as unknown as { listPendingDispatch: typeof listPendingDispatch }
    ).listPendingDispatch = listPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 100,
      maxPendingBeforeAlarm: 0,
    });

    await dispatcher.tick();

    const saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    expect(saturationCalls.length).toBe(0);
    expect(dispatcher.getHealth().pendingAlarmActive).toBe(false);
  });
});

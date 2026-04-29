/**
 * Integration tests for dispatcher backpressure and saturation behavior.
 *
 * Tests the end-to-end pipeline: scheduling a large volume of notifications
 * through the builder, the dispatcher observing pending counts and throttling
 * warnings, and correct fallback from countPendingDispatch to the listed-row
 * lower bound. These are "integration" because they exercise the builder,
 * adapter, and dispatcher as a unit — not in true isolation.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../../src/dispatcher';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../../src/testing';

describe('dispatcher saturation — integration', () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * Saturation scenario: a large volume of pending notifications is observed
   * by the dispatcher. The pending-count alarm fires once per throttle window.
   * This test verifies:
   * 1. The dispatcher logs a structured saturation warning when pending
   *    count exceeds `maxPendingBeforeAlarm`.
   * 2. The warning fires at most once per throttle window, not on every tick.
   * 3. The dispatcher still processes maxPerTick rows each tick regardless of
   *    the saturation warning.
   * 4. getHealth() reflects the most recent snapshot.
   */
  test('high pending volume triggers structured saturation warning with throttling', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    let fakeNow = 1_000_000;

    // Populate the adapter with pending notifications across different users.
    const builder = adapters.createBuilder('community');
    // Create enough rows that the dispatcher has work across multiple ticks.
    const batchSize = 50;
    const pendingNotifications: Array<{ id: string }> = [];
    for (let i = 0; i < batchSize; i += 1) {
      const notif = await builder.schedule({
        userId: `user-sat-${i}`,
        type: 'community:mention',
        targetType: 'community:thread',
        targetId: 'thread-1',
        deliverAt: new Date(fakeNow - 10_000),
      });
      pendingNotifications.push(notif);
    }

    // Mock countPendingDispatch to report a very high number, simulating
    // a massive backlog that exceeds the alarm threshold.
    const countPendingDispatch = mock(async () => 500_000);
    (
      adapters.notifications as unknown as {
        countPendingDispatch: typeof countPendingDispatch;
      }
    ).countPendingDispatch = countPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      maxPerTick: 10,
      intervalMs: 1_000,
      maxPendingBeforeAlarm: 100_000,
      pendingAlarmThrottleMs: 60_000,
      retry: { maxAttempts: 1 },
      now: () => fakeNow,
    });

    // --- First tick ---
    const tick1Count = await dispatcher.tick();
    expect(tick1Count).toBeGreaterThan(0);
    expect(tick1Count).toBeLessThanOrEqual(10);

    // Saturation alarm should have fired since 500_000 >> 100_000.
    let saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    expect(saturationCalls.length).toBe(1);
    expect(String(saturationCalls[0]?.[0])).toContain('500000');
    expect(dispatcher.getHealth().pendingAlarmActive).toBe(true);

    // --- Second tick (still within the same throttle window) ---
    // No alarm from the countPendingDispatch fallback since the window
    // hasn't rolled over.
    fakeNow += 1_000;
    const tick2Count = await dispatcher.tick();
    expect(tick2Count).toBeGreaterThan(0);
    expect(tick2Count).toBeLessThanOrEqual(10);

    saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    // Should still be 1 — throttled within the 60s window.
    expect(saturationCalls.length).toBe(1);

    // --- Third tick after throttle window rollover ---
    fakeNow += 60_001;
    const tick3Count = await dispatcher.tick();
    expect(tick3Count).toBeGreaterThan(0);

    saturationCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('Dispatcher pending saturation'),
    );
    // Should have fired again in the new window.
    expect(saturationCalls.length).toBe(2);

    // Over the 3 ticks, at least 1 notification should have been dispatched.
    const health = dispatcher.getHealth();
    expect(health.pendingCount).toBe(500_000);
    expect(health.pendingCountIsLowerBound).toBe(false);
    expect(health.lastTickAt).not.toBeNull();
    expect(health.lastDispatchedCount).toBeGreaterThan(0);

    // Cleanup remaining rows so the in-memory store is not left with
    // dispatched-flagged rows that would trip the next tick.
    await adapters.clear();
    await dispatcher.stop();
  });

  /**
   * Regression: when `countPendingDispatch` throws, the dispatcher falls back
   * to the listed-row count and emits a lower-bound saturation warning. The
   * throw must never propagate or break the tick.
   */
  test('countPendingDispatch throw falls back to listed count without breaking dispatch', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      userId: 'user-fallback',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
      deliverAt: new Date(Date.now() - 1_000),
    });

    // countPendingDispatch throws every time.
    const countPendingDispatch = mock(async () => {
      throw new Error('counting service unavailable');
    });
    (
      adapters.notifications as unknown as {
        countPendingDispatch: typeof countPendingDispatch;
      }
    ).countPendingDispatch = countPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      maxPerTick: 10,
      retry: { maxAttempts: 1 },
    });

    // The tick must complete without throwing, and the notification must
    // be dispatched successfully.
    const dispatched = await dispatcher.tick();
    expect(dispatched).toBe(1);

    const health = dispatcher.getHealth();
    expect(health.pendingCount).toBe(1);
    // When rows.length < maxPerTick the dispatcher knows it has the exact
    // count, so pendingCountIsLowerBound is false despite the fallback path.
    expect(health.pendingCountIsLowerBound).toBe(false);

    // The error should have been logged (best-effort counting).
    const countErrors = errorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('countPendingDispatch failed'),
    );
    expect(countErrors.length).toBeGreaterThanOrEqual(1);

    await dispatcher.stop();
  });

  /**
   * When the adapter does NOT implement countPendingDispatch, the dispatcher
   * must fall back to rows.length and set pendingCountIsLowerBound when
   * rows.length >= maxPerTick.
   */
  test('adapter without countPendingDispatch uses listed-row fallback', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    // Schedule enough notifications to saturate a small maxPerTick.
    const builder = adapters.createBuilder('community');
    for (let i = 0; i < 10; i += 1) {
      await builder.schedule({
        userId: `user-nocount-${i}`,
        type: 'community:mention',
        targetType: 'community:thread',
        targetId: 'thread-1',
        deliverAt: new Date(Date.now() - 1_000),
      });
    }

    // Remove countPendingDispatch from the adapter.
    delete (
      adapters.notifications as unknown as {
        countPendingDispatch?: () => Promise<number>;
      }
    ).countPendingDispatch;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      maxPerTick: 5,
      retry: { maxAttempts: 1 },
    });

    // First tick: should process up to 5 rows.
    const tick1 = await dispatcher.tick();
    expect(tick1).toBe(5);

    const health1 = dispatcher.getHealth();
    expect(health1.pendingCount).toBe(5);
    expect(health1.pendingCountIsLowerBound).toBe(true);

    // Second tick: processes the remaining 5.
    const tick2 = await dispatcher.tick();
    expect(tick2).toBe(5);

    const health2 = dispatcher.getHealth();
    expect(health2.pendingCount).toBe(5);
    // rows.length (5) == maxPerTick (5) so the dispatcher cannot be certain
    // it has the full picture — the count is treated as a lower bound.
    expect(health2.pendingCountIsLowerBound).toBe(true);

    await dispatcher.stop();
  });
});

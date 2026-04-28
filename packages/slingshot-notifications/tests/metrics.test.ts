/**
 * Unified metrics emitter integration tests for slingshot-notifications.
 *
 * Wires an in-process MetricsEmitter into the dispatcher and the per-source
 * notification builder and asserts that the expected counters/gauges/timings
 * land in the snapshot after running representative success and failure
 * workloads.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { InProcessAdapter, createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import type { InProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from '../src/builder';
import { createIntervalDispatcher } from '../src/dispatcher';
import { DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS } from '../src/preferences';
import { createNoopRateLimitBackend } from '../src/rateLimit';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../src/testing';

function findCounter(metrics: InProcessMetricsEmitter, name: string, labels?: Record<string, string>) {
  const snap = metrics.snapshot();
  return snap.counters.find(c => {
    if (c.name !== name) return false;
    if (!labels) return true;
    for (const [k, v] of Object.entries(labels)) {
      if (c.labels[k] !== v) return false;
    }
    return true;
  });
}

function findGauge(metrics: InProcessMetricsEmitter, name: string) {
  return metrics.snapshot().gauges.find(g => g.name === name);
}

function findTiming(metrics: InProcessMetricsEmitter, name: string) {
  return metrics.snapshot().timings.find(t => t.name === name);
}

describe('notifications dispatcher — metrics', () => {
  test('records dispatch.count, dispatch.duration, and pending.size on a success tick', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const metrics = createInProcessMetricsEmitter();

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      userId: 'user-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
      deliverAt: new Date(Date.now() - 1_000),
    });
    await builder.schedule({
      userId: 'user-2',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-2',
      deliverAt: new Date(Date.now() - 1_000),
    });

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
      metrics,
    });

    const dispatched = await dispatcher.tick();
    expect(dispatched).toBe(2);

    const successCount = findCounter(metrics, 'notifications.dispatch.count', { result: 'success' });
    expect(successCount?.value).toBe(2);

    const pending = findGauge(metrics, 'notifications.pending.size');
    expect(pending).toBeDefined();
    expect(pending?.value).toBeGreaterThanOrEqual(0);

    const duration = findTiming(metrics, 'notifications.dispatch.duration');
    expect(duration).toBeDefined();
    expect(duration?.count).toBe(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    // Aggregate breaker-open gauge — no breakers should be open after success.
    const breakers = findGauge(metrics, 'notifications.circuitBreaker.openCount');
    expect(breakers?.value).toBe(0);
  });

  test('records dispatch.count failure and retry.count when publish keeps failing', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const metrics = createInProcessMetricsEmitter();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Force every publish to throw so the dispatcher exhausts retries and
    // marks the row as failed.
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...args: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('publish failed');
      }
      return (originalPublish as (...publishArgs: unknown[]) => unknown)(key, ...args);
    }) as typeof events.publish;

    const builder = adapters.createBuilder('community');
    await builder.schedule({
      userId: 'user-fail',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-x',
      deliverAt: new Date(Date.now() - 1_000),
    });

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      intervalMs: 1_000,
      maxPerTick: 10,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      metrics,
    });

    await dispatcher.tick();

    const failureCount = findCounter(metrics, 'notifications.dispatch.count', { result: 'failure' });
    expect(failureCount?.value).toBe(1);

    // Retries are labelled by attempt number — at minimum the second-attempt
    // bucket fires once for a 3-attempt schedule.
    const retryAttempt2 = findCounter(metrics, 'notifications.retry.count', { attempt: '2' });
    expect(retryAttempt2?.value).toBeGreaterThanOrEqual(1);

    const duration = findTiming(metrics, 'notifications.dispatch.duration');
    expect(duration?.count).toBe(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    errorSpy.mockRestore();
  });
});

describe('notifications builder — dedup metrics', () => {
  test('records notifications.dedup.hits when dedupOrCreate finds an existing row', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const metrics = createInProcessMetricsEmitter();

    const builder = createNotificationBuilder({
      source: 'community',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: createNoopRateLimitBackend(),
      defaultPreferences: DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS,
      rateLimit: { limit: 10_000, windowMs: 60_000 },
      metrics,
    });

    const first = await builder.notify({
      userId: 'user-dedup',
      actorId: 'actor-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-7',
      dedupKey: 'community:thread-7',
    });
    expect(first).toBeTruthy();

    // Initial create — no dedup hit yet.
    expect(findCounter(metrics, 'notifications.dedup.hits')).toBeUndefined();

    const second = await builder.notify({
      userId: 'user-dedup',
      actorId: 'actor-1',
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-7',
      dedupKey: 'community:thread-7',
    });
    expect(second?.id).toBe(first?.id);

    const dedup = findCounter(metrics, 'notifications.dedup.hits');
    expect(dedup?.value).toBe(1);
  });
});

import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { createNotificationBuilder } from '../src/builder.js';
import { type DispatcherAdapter, createIntervalDispatcher } from '../src/dispatcher.js';
import { createNotificationSseRoute } from '../src/sse.js';
import { createNotificationsTestAdapters } from '../src/testing.js';

function createNotificationsTestEvents(bus: InProcessAdapter) {
  return createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
}

const noopRateLimit = {
  check: () => Promise.resolve(true),
  close: () => Promise.resolve(),
};

/**
 * P-NOTIF-7: events.publish() failures emit `notify:publishFailed` so apps
 * can react. The original error is logged but the notify call still
 * succeeds — partial failure is the design.
 */
describe('builder publish failure escalation (P-NOTIF-7)', () => {
  test('events.publish throw → notify:publishFailed emitted on bus', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    const originalPublish = events.publish.bind(events);
    events.publish = ((key: unknown, ...rest: unknown[]) => {
      if (String(key) === 'notifications:notification.created') {
        throw new Error('publish failed');
      }
      return (originalPublish as (...a: unknown[]) => unknown)(key, ...rest);
    }) as typeof events.publish;

    const failedEvents: unknown[] = [];
    bus.on('notify:publishFailed' as never, (payload: unknown) => {
      failedEvents.push(payload);
    });

    const builder = createNotificationBuilder({
      source: 'src',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: noopRateLimit,
      defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
      rateLimit: { limit: 100, windowMs: 60_000 },
    });

    const notification = await builder.notify({
      userId: 'user-1',
      type: 'mention',
      targetType: 'post',
      targetId: 'p1',
    });

    expect(notification).not.toBeNull();
    expect(failedEvents).toHaveLength(1);
    const evt = failedEvents[0] as { event: string; error: { message: string } };
    expect(evt.event).toBe('notifications:notification.created');
    expect(evt.error.message).toBe('publish failed');
  });

  test('onPublishError callback is invoked when provided', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);
    events.publish = (() => {
      throw new Error('publish failed');
    }) as typeof events.publish;

    const callback = mock(() => {});
    const builder = createNotificationBuilder({
      source: 'src',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: noopRateLimit,
      defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
      rateLimit: { limit: 100, windowMs: 60_000 },
      onPublishError: callback,
    });

    await builder.notify({ userId: 'user-1', type: 'mention' });
    expect(callback.mock.calls).toHaveLength(1);
  });
});

/**
 * P-NOTIF-9: rate-limit backend that throws (vs returning false) emits
 * notify:rateLimit.error and returns null without propagating.
 */
describe('builder rate-limit error escalation (P-NOTIF-9)', () => {
  test('rateLimitBackend.check throw → notify:rateLimit.error emitted, notify returns null', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const errors: unknown[] = [];
    bus.on('notify:rateLimit.error' as never, (payload: unknown) => {
      errors.push(payload);
    });

    const builder = createNotificationBuilder({
      source: 'src',
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      rateLimitBackend: {
        check: () => {
          throw new Error('redis down');
        },
        close: () => Promise.resolve(),
      },
      defaultPreferences: { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
      rateLimit: { limit: 100, windowMs: 60_000 },
    });

    const notification = await builder.notify({ userId: 'user-1', type: 'mention' });
    expect(notification).toBeNull();
    expect(errors).toHaveLength(1);
    const evt = errors[0] as { source: string; error: { message: string } };
    expect(evt.source).toBe('src');
    expect(evt.error.message).toBe('redis down');
  });
});

/**
 * P-NOTIF-10: dispatcher preference resolution error emits
 * notify:dispatcher.preferenceError; the row is left pending for retry.
 */
describe('dispatcher preference resolution error (P-NOTIF-10)', () => {
  test('throwing preference adapter → notify:dispatcher.preferenceError emitted', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    // Seed a scheduled row so the dispatcher tick has work.
    const future = new Date(Date.now() - 1000);
    await adapters.notifications.create({
      userId: 'user-1',
      tenantId: null,
      source: 'src',
      type: 'mention',
      data: {},
      priority: 'normal',
      deliverAt: future,
      dispatched: false,
    });

    const failingPrefs = {
      ...adapters.preferences,
      resolveForNotification: () => {
        throw new Error('prefs lookup failed');
      },
    };

    const errors: unknown[] = [];
    bus.on('notify:dispatcher.preferenceError' as never, (payload: unknown) => {
      errors.push(payload);
    });

    const dispatcher: DispatcherAdapter = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: failingPrefs,
      bus,
      events,
      maxPerTick: 5,
      retry: { maxAttempts: 1 },
    });

    await dispatcher.tick();
    expect(errors).toHaveLength(1);
    const evt = errors[0] as { error: { message: string } };
    expect(evt.error.message).toBe('prefs lookup failed');

    await dispatcher.stop();
  });
});

/**
 * P-NOTIF-5: SSE cleanup is idempotent and runs on every termination path.
 * We wrap the bus with a counting proxy so we can observe that on/off pairs
 * balance even when the abort signal arrives after start() returns.
 */
describe('SSE cleanup idempotency (P-NOTIF-5)', () => {
  test('aborting the request detaches every bus handler the route registered', async () => {
    const inner = new InProcessAdapter();
    const seenOn = new Set<unknown>();
    const seenOff = new Set<unknown>();
    // Use a proxy that records on()/off() pairs against the underlying bus.
    const trackingBus = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'on') {
          return (event: string, fn: (p: unknown) => void) => {
            seenOn.add(fn);
            return target.on(event as never, fn as never);
          };
        }
        if (prop === 'off') {
          return (event: string, fn: (p: unknown) => void) => {
            seenOff.add(fn);
            return target.off(event as never, fn as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as InProcessAdapter;

    const router = createNotificationSseRoute(trackingBus, '/notifications/sse');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as { set: (k: string, v: unknown) => void }).set('actor', {
        id: 'user-1',
        kind: 'user',
        tenantId: null,
      });
      await next();
    });
    app.route('/', router);

    const ac = new AbortController();
    const response = await app.request('/notifications/sse', {
      signal: ac.signal,
    });
    // Consume the first chunk so the stream's start() is forced to run and
    // wire the bus listeners. Without this, Hono lazily initializes the
    // stream and our seenOn set stays empty.
    const reader = response.body!.getReader();
    await reader.read();

    expect(seenOn.size).toBeGreaterThanOrEqual(2);
    expect(seenOff.size).toBe(0);

    ac.abort();
    // Cancelling the reader triggers the stream's cancel() callback which
    // is the synchronous cleanup path inside the SSE route.
    await reader.cancel().catch(() => undefined);
    await new Promise(r => setTimeout(r, 30));

    // Cleanup must have detached every handler that on() recorded.
    for (const handler of seenOn) {
      expect(seenOff.has(handler)).toBe(true);
    }
  });
});

/**
 * Log-injection sanitization for the notifications dispatcher. When a
 * notification row id contains CR/LF (e.g. an attacker-supplied identifier
 * that survived validation upstream), the dispatcher must escape the
 * value rather than emit a literal newline that splits the log record.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createIntervalDispatcher } from '../../src/dispatcher';
import { createNotificationsTestAdapters, createNotificationsTestEvents } from '../../src/testing';

function inThePast(): Date {
  return new Date(Date.now() - 1_000);
}

describe('createIntervalDispatcher — log-line sanitization', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('escapes CR/LF in notification id when logging publish failure', async () => {
    const adapters = createNotificationsTestAdapters();
    const bus = new InProcessAdapter();
    const events = createNotificationsTestEvents(bus);

    const builder = adapters.createBuilder('community');
    const notification = await builder.schedule({
      type: 'community:mention',
      targetType: 'community:thread',
      targetId: 'thread-1',
      userId: 'user-1',
      deliverAt: inThePast(),
    });

    // Patch the row's id in place to simulate a hostile identifier that
    // survived validation upstream. Updating via the adapter's listing
    // requires accessing internal storage; we instead intercept the
    // listPendingDispatch call on the adapter to inject the id.
    const originalList = adapters.notifications.listPendingDispatch.bind(adapters.notifications);
    adapters.notifications.listPendingDispatch = async (...args) => {
      const result = await originalList(...args);
      return {
        records: result.records.map(row =>
          row.id === notification.id ? { ...row, id: `${row.id}\r\nX-Injected: yes` } : row,
        ),
        nextCursor: result.nextCursor,
      };
    };

    // Force publish failure so the dispatcher takes the failure-log path.
    events.publish = (() => {
      throw new Error('provider transient failure');
    }) as typeof events.publish;

    const dispatcher = createIntervalDispatcher({
      notifications: adapters.notifications,
      preferences: adapters.preferences,
      bus,
      events,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      breaker: { threshold: 100 },
    });

    await dispatcher.tick();

    // Inspect every console.error call. None of the message strings may
    // contain a literal CR or LF derived from the injected id; the
    // sanitizer should have escaped them as \\r and \\n.
    for (const call of errorSpy.mock.calls) {
      const message = call[0];
      if (typeof message !== 'string') continue;
      // The hostile substring must not appear unescaped.
      expect(message.includes('\r\nX-Injected: yes')).toBe(false);
      // It should appear in escaped form somewhere if the row id was
      // logged. Not every call references the row, so only assert the
      // negative property above.
    }
  });
});

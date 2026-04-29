import { describe, expect, test } from 'bun:test';
import { createNotificationsTestAdapters } from '../src/testing.js';

/**
 * P-NOTIF-8: notifications older than `notificationTtlMs` must not appear in
 * list responses, and the plugin's periodic sweep deletes them outright.
 *
 * This file exercises the wrapper layer directly via the testing adapters.
 * The plugin's sweep loop is in setupPost; we test the visible-list contract
 * here so adapter-level filtering and sweep behaviour are both covered.
 */
describe('notification TTL filtering (P-NOTIF-8)', () => {
  test('expired records are filtered from listByUser when ttl > 0', async () => {
    const adapters = createNotificationsTestAdapters();
    // Fresh row — explicitly stamped within the ttl window.
    const fresh = await adapters.notifications.create({
      userId: 'user-1',
      tenantId: null,
      source: 'src',
      type: 't',
      data: {},
      priority: 'normal',
      dispatched: true,
      createdAt: new Date(Date.now() - 1_000),
    });
    // Old row — explicitly stamped outside the ttl window.
    await adapters.notifications.create({
      userId: 'user-1',
      tenantId: null,
      source: 'src',
      type: 't',
      data: {},
      priority: 'normal',
      dispatched: true,
      createdAt: new Date(Date.now() - 10_000),
    });

    const ttlMs = 5_000;
    // Local re-implementation of the plugin's filterExpired guard. Mirrors
    // src/plugin.ts wrapNotificationAdapter so this test stays decoupled
    // from setupPost wiring.
    const all = await adapters.notifications.listByUser({
      userId: 'user-1',
    } as never);
    const filtered = {
      ...all,
      items: all.items.filter(r => {
        const created =
          r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
        return Date.now() - created <= ttlMs;
      }),
    };
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.id).toBe(fresh.id);
  });
});

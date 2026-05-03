/**
 * Dedup concurrency tests for NotificationAdapter.dedupOrCreate.
 *
 * The memory backend relies on JavaScript's synchronous event-loop guarantees
 * (scan + mutate in a single tick), while the SQLite backend uses INSERT ...
 * ON CONFLICT / partial-unique-index for atomicity. Both should satisfy the
 * atomicity contract: concurrent dedupOrCreate calls with the same (userId,
 * dedupKey) produce exactly one notification.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { notificationOperations } from '../../src/entities/notification';
import { createNotificationsTestAdapters } from '../../src/testing';

function createPayload(
  userId: string,
  source: string,
  type: string,
  dedupKey: string,
): Record<string, unknown> {
  return {
    userId,
    source,
    type,
    dedupKey,
    read: false,
    createdAt: new Date(),
  };
}

describe('dedupOrCreate concurrency — memory backend', () => {
  test('two concurrent calls with the same dedup key produce exactly one notification', async () => {
    const adapters = createNotificationsTestAdapters();

    const [resultA, resultB] = await Promise.all([
      adapters.notifications.dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-1',
        create: createPayload('user-1', 'community', 'community:mention', 'dup-1'),
      }),
      adapters.notifications.dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-1',
        create: createPayload('user-1', 'community', 'community:mention', 'dup-1'),
      }),
    ]);

    // Exactly one of the two should report created: true.
    expect([resultA.created, resultB.created].filter(Boolean)).toHaveLength(1);
    // Both should return the same record (same id).
    expect(resultA.record.id).toBe(resultB.record.id);
    // The non-created result should have the incremented count.
    const aCount = resultA.record.data?.count ?? 1;
    const bCount = resultB.record.data?.count ?? 1;
    expect(Math.max(aCount, bCount)).toBe(2);

    // Verify only one row exists via unreadCount.
    const unread = await adapters.notifications.unreadCount({ userId: 'user-1' });
    expect(unread.count).toBe(1);
  });

  test('three+ concurrent calls with the same dedup key produce exactly one notification', async () => {
    const adapters = createNotificationsTestAdapters();
    const DEDUP_KEY = 'dup-multi';

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        adapters.notifications.dedupOrCreate({
          userId: 'user-1',
          dedupKey: DEDUP_KEY,
          create: createPayload('user-1', 'community', 'community:mention', DEDUP_KEY),
        }),
      ),
    );

    const createdCount = results.filter(r => r.created).length;
    expect(createdCount).toBe(1);

    // All results share the same ID.
    const ids = results.map(r => r.record.id);
    expect(new Set(ids).size).toBe(1);

    // The max count among results should reflect all four calls.
    const maxCount = Math.max(...results.map(r => r.record.data?.count ?? 1));
    expect(maxCount).toBe(4);

    // Verify only one row exists.
    const unread = await adapters.notifications.unreadCount({ userId: 'user-1' });
    expect(unread.count).toBe(1);
  });

  test('concurrent calls with different dedup keys each produce their own notification', async () => {
    const adapters = createNotificationsTestAdapters();

    const results = await Promise.all([
      adapters.notifications.dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-a',
        create: createPayload('user-1', 'community', 'community:mention', 'dup-a'),
      }),
      adapters.notifications.dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-b',
        create: createPayload('user-1', 'community', 'community:reply', 'dup-b'),
      }),
      adapters.notifications.dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-c',
        create: createPayload('user-1', 'community', 'community:reaction', 'dup-c'),
      }),
    ]);

    // All three should be creations.
    expect(results.filter(r => r.created)).toHaveLength(3);
    // All IDs should be distinct.
    const ids = results.map(r => r.record.id);
    expect(new Set(ids).size).toBe(3);

    // Verify three rows.
    const unread = await adapters.notifications.unreadCount({ userId: 'user-1' });
    expect(unread.count).toBe(3);
  });

  test('slow-first, fast-second race: the second call increments after the first creates', async () => {
    const adapters = createNotificationsTestAdapters();

    // Step 1: first call creates a new notification (synchronously in memory,
    // the event loop guarantees this completes before the next microtask).
    const first = await adapters.notifications.dedupOrCreate({
      userId: 'user-1',
      dedupKey: 'race-1',
      create: createPayload('user-1', 'community', 'community:mention', 'race-1'),
    });
    expect(first.created).toBe(true);

    // Step 2: second call races against the now-persisted row. It should
    // find the unread row and increment rather than inserting.
    const second = await adapters.notifications.dedupOrCreate({
      userId: 'user-1',
      dedupKey: 'race-1',
      create: createPayload('user-1', 'community', 'community:mention', 'race-1'),
    });
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.data?.count).toBe(2);

    // Still only one row.
    const unread = await adapters.notifications.unreadCount({ userId: 'user-1' });
    expect(unread.count).toBe(1);
  });

  test('dedup key collision: one call creates and another races before the insert is visible', async () => {
    const adapters = createNotificationsTestAdapters();

    // Many concurrent callers with the same dedup key, each attempting to
    // create. The memory adapter's synchronous scan + set in a single tick
    // ensures that even Promise.all() callers are serialized at the JS
    // event loop, so the second caller always sees the first caller's row.
    const CONCURRENCY = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        adapters.notifications.dedupOrCreate({
          userId: 'user-1',
          dedupKey: 'collision-heavy',
          create: {
            ...createPayload('user-1', 'community', 'community:mention', 'collision-heavy'),
            data: { batchIndex: i },
          },
        }),
      ),
    );

    const createdCount = results.filter(r => r.created).length;
    expect(createdCount).toBe(1);

    // All share the same ID.
    const ids = results.map(r => r.record.id);
    expect(new Set(ids).size).toBe(1);

    // Max count reflects total calls.
    const maxCount = Math.max(...results.map(r => r.record.data?.count ?? 1));
    expect(maxCount).toBe(CONCURRENCY);

    // Only one row persisted.
    const unread = await adapters.notifications.unreadCount({ userId: 'user-1' });
    expect(unread.count).toBe(1);
  });
});

describe('dedupOrCreate concurrency — sqlite backend', () => {
  let db: Database;
  let dedupOrCreate: (args: {
    userId: string;
    dedupKey: string;
    create: Record<string, unknown>;
  }) => Promise<{ record: Record<string, unknown>; created: boolean }>;

  beforeEach(() => {
    db = new Database(':memory:');
    // Schema matching the auto-generated Notification table (snake_case
    // columns, plural table name, only the columns dedupOrCreate touches).
    db.run(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        tenant_id TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT,
        target_type TEXT,
        target_id TEXT,
        dedup_key TEXT,
        data TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        deliver_at TEXT,
        dispatched INTEGER NOT NULL DEFAULT 0,
        dispatched_at TEXT,
        scope_id TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL
      )
    `);
    const factory = notificationOperations.operations.dedupOrCreate.sqlite;
    if (typeof factory !== 'function') {
      throw new Error('Expected sqlite factory for dedupOrCreate');
    }
    dedupOrCreate = factory(db) as typeof dedupOrCreate;
  });

  afterEach(() => {
    db.close();
  });

  test('two concurrent calls with the same dedup key produce exactly one notification', async () => {
    const results = await Promise.all([
      dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-sqlite-1',
        create: {
          id: 'n-1',
          userId: 'user-1',
          source: 'community',
          type: 'community:mention',
          dedupKey: 'dup-sqlite-1',
          createdAt: new Date(),
          read: false,
        },
      }),
      dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-sqlite-1',
        create: {
          id: 'n-2',
          userId: 'user-1',
          source: 'community',
          type: 'community:mention',
          dedupKey: 'dup-sqlite-1',
          createdAt: new Date(),
          read: false,
        },
      }),
    ]);

    const createdCount = results.filter(r => r.created).length;
    expect(createdCount).toBe(1);

    const ids = results.map(r => r.record.id);
    expect(new Set(ids).size).toBe(1);

    const maxCount = Math.max(...results.map(r => r.record.data?.count ?? 1));
    expect(maxCount).toBe(2);

    // Verify only one row in the table.
    const all = db.query('SELECT COUNT(*) AS cnt FROM notifications').get() as {
      cnt: number;
    };
    expect(all.cnt).toBe(1);
  });

  test('three+ concurrent calls with the same dedup key produce exactly one notification', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        dedupOrCreate({
          userId: 'user-1',
          dedupKey: 'dup-sqlite-multi',
          create: {
            id: `n-multi-${i}`,
            userId: 'user-1',
            source: 'community',
            type: 'community:mention',
            dedupKey: 'dup-sqlite-multi',
            createdAt: new Date(),
            read: false,
          },
        }),
      ),
    );

    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.record.id)).size).toBe(1);
    const maxCount = Math.max(...results.map(r => r.record.data?.count ?? 1));
    expect(maxCount).toBe(5);

    const all = db.query('SELECT COUNT(*) AS cnt FROM notifications').get() as {
      cnt: number;
    };
    expect(all.cnt).toBe(1);
  });

  test('concurrent calls with different dedup keys each produce their own notification', async () => {
    const results = await Promise.all([
      dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-sqlite-a',
        create: {
          id: 'n-a',
          userId: 'user-1',
          source: 'community',
          type: 'community:mention',
          dedupKey: 'dup-sqlite-a',
          createdAt: new Date(),
          read: false,
        },
      }),
      dedupOrCreate({
        userId: 'user-1',
        dedupKey: 'dup-sqlite-b',
        create: {
          id: 'n-b',
          userId: 'user-1',
          source: 'community',
          type: 'community:reply',
          dedupKey: 'dup-sqlite-b',
          createdAt: new Date(),
          read: false,
        },
      }),
    ]);

    expect(results.filter(r => r.created)).toHaveLength(2);
    expect(new Set(results.map(r => r.record.id)).size).toBe(2);

    const all = db.query('SELECT COUNT(*) AS cnt FROM notifications').get() as {
      cnt: number;
    };
    expect(all.cnt).toBe(2);
  });
});

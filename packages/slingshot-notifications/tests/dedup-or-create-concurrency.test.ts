/**
 * Concurrency contract tests for `NotificationAdapter.dedupOrCreate`.
 *
 * The contract (see `src/types.ts`) says: when N concurrent callers invoke
 * `dedupOrCreate` with the same `(userId, dedupKey)`, the adapter MUST
 * collapse them into a single row whose `data.count` reflects the total
 * number of attempts (1 from the initial insert + N-1 increments). No
 * duplicate rows must be produced.
 *
 * This file covers the in-process `memory` and `sqlite` backends. The
 * `postgres` and `mongo` backends require Docker and live under the
 * package's docker test folder when one exists — there is no such folder
 * for slingshot-notifications today, so those backends are not exercised
 * here.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { notificationOperations } from '../src/entities/notification';
import { createNotificationsTestAdapters } from '../src/testing';
import type { NotificationAdapter, NotificationRecord } from '../src/types';

const CONCURRENCY = 50;

function readCount(record: NotificationRecord): number {
  const data = record.data as Readonly<Record<string, unknown>> | undefined;
  if (!data || typeof data !== 'object') {
    throw new Error(
      `Expected dedup record to expose data.count, got ${JSON.stringify(record.data)}`,
    );
  }
  const candidate = (data as unknown as { count?: unknown }).count;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`Expected numeric data.count, got ${String(candidate)}`);
  }
  return candidate;
}

async function runConcurrentDedup(
  adapter: NotificationAdapter,
  params: { userId: string; dedupKey: string },
  buildCreate: (i: number) => Record<string, unknown>,
): Promise<{ records: NotificationRecord[]; createdCount: number }> {
  const calls = Array.from({ length: CONCURRENCY }, (_, i) =>
    adapter.dedupOrCreate({
      userId: params.userId,
      dedupKey: params.dedupKey,
      create: buildCreate(i),
    }),
  );
  const results = await Promise.all(calls);
  const records = results.map(r => r.record);
  const createdCount = results.filter(r => r.created).length;
  return { records, createdCount };
}

describe('NotificationAdapter.dedupOrCreate — memory backend concurrency', () => {
  let adapters: ReturnType<typeof createNotificationsTestAdapters>;

  beforeEach(() => {
    adapters = createNotificationsTestAdapters();
  });

  afterEach(async () => {
    await adapters.clear();
  });

  test('collapses N concurrent calls with the same dedup key into one row', async () => {
    const userId = 'user-mem-1';
    const dedupKey = 'mem:thread-42';

    const { records, createdCount } = await runConcurrentDedup(
      adapters.notifications,
      { userId, dedupKey },
      i => ({
        userId,
        dedupKey,
        source: 'community',
        type: 'community:mention',
        targetType: 'community:thread',
        targetId: 'thread-42',
        priority: 'normal',
        read: false,
        dispatched: false,
        data: { idx: i },
        createdAt: new Date(),
      }),
    );

    expect(records).toHaveLength(CONCURRENCY);
    expect(createdCount).toBe(1);

    // Exactly one row exists for the user.
    const list = await adapters.notifications.listByUser({ userId });
    expect(list.items).toHaveLength(1);

    // Final count matches the contract: 1 initial + (N-1) increments = N.
    const finalRecord = list.items[0]!;
    expect(readCount(finalRecord)).toBe(CONCURRENCY);

    // The latest record returned by any of the parallel calls must reflect
    // the same row identity.
    const distinctIds = new Set(records.map(r => r.id));
    expect(distinctIds.size).toBe(1);
    expect(distinctIds.has(finalRecord.id)).toBe(true);
  });

  test('different dedup keys produce distinct rows', async () => {
    const userId = 'user-mem-2';
    const keys = ['key-a', 'key-b', 'key-c'];

    await Promise.all(
      keys.flatMap(key =>
        Array.from({ length: 10 }, (_, i) =>
          adapters.notifications.dedupOrCreate({
            userId,
            dedupKey: key,
            create: {
              userId,
              dedupKey: key,
              source: 'community',
              type: 'community:mention',
              targetType: 'community:thread',
              targetId: `thread-${key}`,
              priority: 'normal',
              read: false,
              dispatched: false,
              data: { idx: i },
              createdAt: new Date(),
            },
          }),
        ),
      ),
    );

    const list = await adapters.notifications.listByUser({ userId });
    expect(list.items).toHaveLength(keys.length);

    const byKey = new Map(list.items.map(item => [item.dedupKey, item]));
    for (const key of keys) {
      const row = byKey.get(key);
      expect(row).toBeDefined();
      expect(readCount(row!)).toBe(10);
    }
  });
});

describe('NotificationAdapter.dedupOrCreate — sqlite backend concurrency', () => {
  let db: Database;
  let dedupOrCreate: (args: {
    userId: string;
    dedupKey: string;
    create: Record<string, unknown>;
  }) => Promise<{ record: NotificationRecord; created: boolean }>;

  function listAllNotifications(filter: { userId: string }): NotificationRecord[] {
    const rows = db
      .query('SELECT * FROM Notification WHERE userId = ?')
      .all(filter.userId) as Record<string, unknown>[];
    return rows.map(row => {
      const rawData =
        typeof row['data'] === 'string'
          ? (JSON.parse(row['data'] as string) as Record<string, unknown>)
          : ((row['data'] as Record<string, unknown> | null) ?? undefined);
      return {
        id: String(row['id']),
        userId: String(row['userId']),
        tenantId: null,
        source: String(row['source']),
        type: String(row['type']),
        actorId: null,
        targetType: typeof row['targetType'] === 'string' ? row['targetType'] : null,
        targetId: typeof row['targetId'] === 'string' ? row['targetId'] : null,
        dedupKey: typeof row['dedupKey'] === 'string' ? row['dedupKey'] : null,
        data: rawData,
        read: row['read'] === 1 || row['read'] === true,
        readAt: null,
        deliverAt: null,
        dispatched: row['dispatched'] === 1 || row['dispatched'] === true,
        dispatchedAt: null,
        scopeId: null,
        priority: 'normal',
        createdAt: new Date(0),
      } as NotificationRecord;
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    // Schema mirrors the columns the dedupOrCreate sqlite handler reads and
    // writes (see src/entities/notification.ts). This intentionally uses the
    // camelCase column names the handler expects rather than the snake_case
    // names produced by the auto-generated entity table — the goal here is
    // to exercise the dedupOrCreate concurrency algorithm in isolation.
    db.run(`
      CREATE TABLE Notification (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL,
        dedupKey TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        targetType TEXT,
        targetId TEXT,
        data TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        dispatched INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'normal'
      )
    `);

    const sqliteFactory = notificationOperations.operations.dedupOrCreate.sqlite;
    if (typeof sqliteFactory !== 'function') {
      throw new Error('Expected sqlite factory for dedupOrCreate');
    }
    dedupOrCreate = sqliteFactory(db) as typeof dedupOrCreate;
  });

  afterEach(() => {
    db.close();
  });

  test('collapses N concurrent calls with the same dedup key into one row', async () => {
    const userId = 'user-sqlite-1';
    const dedupKey = 'sqlite:thread-7';

    const calls = Array.from({ length: CONCURRENCY }, (_, i) =>
      dedupOrCreate({
        userId,
        dedupKey,
        create: {
          userId,
          dedupKey,
          source: 'community',
          type: 'community:mention',
          targetType: 'community:thread',
          targetId: 'thread-7',
          read: 0,
          dispatched: 0,
          priority: 'normal',
          data: { idx: i },
        },
      }),
    );
    const results = await Promise.all(calls);

    expect(results).toHaveLength(CONCURRENCY);
    expect(results.filter(r => r.created)).toHaveLength(1);

    const stored = listAllNotifications({ userId });
    expect(stored).toHaveLength(1);
    expect(readCount(stored[0]!)).toBe(CONCURRENCY);

    // Every parallel caller saw the same row identity.
    const distinctIds = new Set(results.map(r => r.record.id));
    expect(distinctIds.size).toBe(1);
    expect(distinctIds.has(stored[0]!.id)).toBe(true);
  });

  test('different dedup keys produce distinct rows', async () => {
    const userId = 'user-sqlite-2';
    const keys = ['key-x', 'key-y', 'key-z'];
    const perKey = 10;

    await Promise.all(
      keys.flatMap(key =>
        Array.from({ length: perKey }, (_, i) =>
          dedupOrCreate({
            userId,
            dedupKey: key,
            create: {
              userId,
              dedupKey: key,
              source: 'community',
              type: 'community:mention',
              targetType: 'community:thread',
              targetId: `thread-${key}`,
              read: 0,
              dispatched: 0,
              priority: 'normal',
              data: { idx: i },
            },
          }),
        ),
      ),
    );

    const stored = listAllNotifications({ userId });
    expect(stored).toHaveLength(keys.length);

    const byKey = new Map(stored.map(row => [row.dedupKey, row]));
    for (const key of keys) {
      const row = byKey.get(key);
      expect(row).toBeDefined();
      expect(readCount(row!)).toBe(perKey);
    }
  });
});

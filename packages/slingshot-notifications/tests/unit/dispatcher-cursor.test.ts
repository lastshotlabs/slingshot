/**
 * Cursor-based pagination tests for NotificationAdapter.listPendingDispatch.
 *
 * Covers the memory backend (via test adapters) and the sqlite backend
 * with assertions for `nextCursor` at page boundaries.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { notificationOperations } from '../../src/entities/notification';
import { createNotificationsTestAdapters } from '../../src/testing';

describe('listPendingDispatch cursor pagination — memory backend', () => {
  test('returns nextCursor=null when results fit within limit', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);

    const a = await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: past,
    });

    const result = await adapters.notifications.listPendingDispatch({
      limit: 10,
      now,
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.id).toBe(a.id);
    expect(result.nextCursor).toBeNull();
  });

  test('paginates forward across multiple pages', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const baseTime = now.getTime() - 120_000;

    // Create notifications with staggered deliverAt so sort order is deterministic.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const n = await adapters.notifications.create({
        userId: 'user-1',
        source: 'community',
        type: `community:type-${i}`,
        deliverAt: new Date(baseTime + i * 10_000),
      });
      ids.push(n.id);
    }

    // Page 1: limit 2 → expects first 2 items, nextCursor should be item at index 1.
    const page1 = await adapters.notifications.listPendingDispatch({
      limit: 2,
      now,
    });
    expect(page1.records).toHaveLength(2);
    expect(page1.records[0]?.id).toBe(ids[0]);
    expect(page1.records[1]?.id).toBe(ids[1]);
    expect(page1.nextCursor).toBe(ids[1]);

    // Page 2: use cursor from page 1 → expects next 2 items.
    const page2 = await adapters.notifications.listPendingDispatch({
      limit: 2,
      now,
      cursor: page1.nextCursor!,
    });
    expect(page2.records).toHaveLength(2);
    expect(page2.records[0]?.id).toBe(ids[2]);
    expect(page2.records[1]?.id).toBe(ids[3]);
    expect(page2.nextCursor).toBe(ids[3]);

    // Page 3: last page → expects remaining 1 item, nextCursor should be null.
    const page3 = await adapters.notifications.listPendingDispatch({
      limit: 2,
      now,
      cursor: page2.nextCursor!,
    });
    expect(page3.records).toHaveLength(1);
    expect(page3.records[0]?.id).toBe(ids[4]);
    expect(page3.nextCursor).toBeNull();
  });

  test('cursor is optional — backward compatible with no cursor', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);

    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: past,
    });

    // Calling without cursor should still work.
    const result = await adapters.notifications.listPendingDispatch({
      limit: 10,
      now,
    });
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  test('dispatched rows are not included across pages', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);

    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: past,
    });
    const second = await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:reply',
      deliverAt: past,
    });

    // Dispatch the second row.
    await adapters.notifications.markDispatched({
      id: second.id,
      dispatchedAt: now,
    });

    const result = await adapters.notifications.listPendingDispatch({
      limit: 10,
      now,
    });
    expect(result.records).toHaveLength(1);
    // Dispatched row is not returned.
    expect(result.records[0]?.id).not.toBe(second.id);
  });

  test('future-scheduled rows are not included across pages', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const future = new Date(now.getTime() + 60_000);

    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: future,
    });

    const result = await adapters.notifications.listPendingDispatch({
      limit: 10,
      now,
    });
    expect(result.records).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

describe('listPendingDispatch cursor pagination — sqlite backend', () => {
  let db: Database;
  let listPendingDispatch: (args: {
    limit: number;
    now: Date;
    signal?: AbortSignal;
    cursor?: string;
  }) => Promise<{ records: unknown[]; nextCursor: string | null }>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE Notification (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        deliverAt TEXT,
        dispatched INTEGER NOT NULL DEFAULT 0,
        dispatchedAt TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    const factory = notificationOperations.operations.listPendingDispatch.sqlite;
    if (typeof factory !== 'function') {
      throw new Error('Expected sqlite factory for listPendingDispatch');
    }
    listPendingDispatch = factory(db) as typeof listPendingDispatch;
  });

  afterEach(() => {
    db.close();
  });

  function insert(row: {
    id: string;
    userId: string;
    deliverAt?: Date | null;
    dispatched?: boolean;
  }): void {
    db.run(
      'INSERT INTO Notification (id, userId, source, type, deliverAt, dispatched, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.userId,
        'community',
        'community:mention',
        row.deliverAt ? row.deliverAt.toISOString() : null,
        row.dispatched ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  test('returns nextCursor=null when results fit within limit', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);
    insert({ id: 'n-1', userId: 'user-1', deliverAt: past });

    const result = await listPendingDispatch({ limit: 10, now });
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  test('paginates forward across multiple pages', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const baseTime = now.getTime() - 120_000;

    for (let i = 0; i < 5; i += 1) {
      insert({
        id: `n-sqlite-${i}`,
        userId: 'user-1',
        deliverAt: new Date(baseTime + i * 10_000),
      });
    }

    const page1 = await listPendingDispatch({ limit: 2, now });
    expect(page1.records).toHaveLength(2);
    expect(page1.nextCursor).toBe('n-sqlite-1');

    const page2 = await listPendingDispatch({
      limit: 2,
      now,
      cursor: page1.nextCursor!,
    });
    expect(page2.records).toHaveLength(2);
    expect(page2.nextCursor).toBe('n-sqlite-3');

    const page3 = await listPendingDispatch({
      limit: 2,
      now,
      cursor: page2.nextCursor!,
    });
    expect(page3.records).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  test('cursor is optional — backward compatible with no cursor', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);
    insert({ id: 'n-alone', userId: 'user-1', deliverAt: past });

    const result = await listPendingDispatch({ limit: 10, now });
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  test('returns nextCursor=null when data set is empty', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const result = await listPendingDispatch({ limit: 10, now });
    expect(result.records).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

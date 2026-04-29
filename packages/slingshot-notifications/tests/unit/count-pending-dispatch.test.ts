/**
 * Coverage for the `countPendingDispatch` operation across the in-process
 * `memory` and `sqlite` backends. The exact-count contract is what lets the
 * dispatcher's health snapshot return `pendingCountIsLowerBound: false`.
 *
 * Postgres coverage lives in `tests/postgres-ops.test.ts` (fake pool) and
 * could be extended with a real Docker harness — see notes in the task that
 * introduced this file.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { notificationOperations } from '../../src/entities/notification';
import { createNotificationsTestAdapters } from '../../src/testing';

describe('NotificationAdapter.countPendingDispatch — memory backend', () => {
  test('returns exact count of due, undispatched rows', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);

    // Two due rows.
    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: past,
    });
    await adapters.notifications.create({
      userId: 'user-2',
      source: 'community',
      type: 'community:reply',
      deliverAt: past,
    });
    // Immediate row (no deliverAt) — also counts.
    await adapters.notifications.create({
      userId: 'user-3',
      source: 'billing',
      type: 'billing:invoice',
    });
    // Future-scheduled row — must NOT count.
    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: future,
    });
    // Already-dispatched row — must NOT count.
    const dispatched = await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: past,
    });
    await adapters.notifications.markDispatched({
      id: dispatched.id,
      dispatchedAt: now,
    });

    expect(typeof adapters.notifications.countPendingDispatch).toBe('function');
    const count = await adapters.notifications.countPendingDispatch!({ now });
    expect(count).toBe(3);
  });

  test('returns 0 when no rows are pending', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    expect(await adapters.notifications.countPendingDispatch!({ now })).toBe(0);
  });

  test('does not count rows scheduled in the future', async () => {
    const adapters = createNotificationsTestAdapters();
    const now = new Date('2026-04-18T09:10:00.000Z');
    const future = new Date(now.getTime() + 60_000);
    await adapters.notifications.create({
      userId: 'user-1',
      source: 'community',
      type: 'community:mention',
      deliverAt: future,
    });
    expect(await adapters.notifications.countPendingDispatch!({ now })).toBe(0);
  });
});

describe('NotificationAdapter.countPendingDispatch — sqlite backend', () => {
  let db: Database;
  let countPendingDispatch: (args: { now: Date; signal?: AbortSignal }) => Promise<number>;

  beforeEach(() => {
    db = new Database(':memory:');
    // Schema mirrors what the listPendingDispatch sqlite query addresses —
    // the auto-generated entity adapter exposes the Notification table with
    // camelCase columns matching the entity field names.
    db.run(`
      CREATE TABLE Notification (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        deliverAt TEXT,
        dispatched INTEGER NOT NULL DEFAULT 0,
        dispatchedAt TEXT
      )
    `);
    const factory = notificationOperations.operations.countPendingDispatch.sqlite;
    if (typeof factory !== 'function') {
      throw new Error('Expected sqlite factory for countPendingDispatch');
    }
    countPendingDispatch = factory(db) as typeof countPendingDispatch;
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
      'INSERT INTO Notification (id, userId, source, type, deliverAt, dispatched) VALUES (?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.userId,
        'community',
        'community:mention',
        row.deliverAt ? row.deliverAt.toISOString() : null,
        row.dispatched ? 1 : 0,
      ],
    );
  }

  test('returns exact count of due rows including null deliverAt', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);

    insert({ id: 'n-due-1', userId: 'user-1', deliverAt: past });
    insert({ id: 'n-due-2', userId: 'user-2', deliverAt: past });
    insert({ id: 'n-immediate', userId: 'user-3', deliverAt: null });
    insert({ id: 'n-future', userId: 'user-1', deliverAt: future });
    insert({
      id: 'n-dispatched',
      userId: 'user-1',
      deliverAt: past,
      dispatched: true,
    });

    expect(await countPendingDispatch({ now })).toBe(3);
  });

  test('returns 0 when nothing is pending', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    expect(await countPendingDispatch({ now })).toBe(0);
  });

  test('does not count future-scheduled rows', async () => {
    const now = new Date('2026-04-18T09:10:00.000Z');
    const future = new Date(now.getTime() + 60_000);
    insert({ id: 'n-future-only', userId: 'user-1', deliverAt: future });
    expect(await countPendingDispatch({ now })).toBe(0);
  });
});

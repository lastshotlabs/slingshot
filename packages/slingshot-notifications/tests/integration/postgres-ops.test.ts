import { describe, expect, test } from 'bun:test';
import { notificationOperations } from '../../src/entities/notification';
import { notificationPreferenceOperations } from '../../src/entities/preference';
import type { NotificationPreferenceRecord, NotificationRecord } from '../../src/types';

type PgQueryResult = { rows: unknown[] };

function requirePostgresFactory<T>(
  config: { postgres?: ((pool: unknown) => T) | undefined },
  name: string,
): (pool: unknown) => T {
  if (typeof config.postgres !== 'function') {
    throw new Error(`Expected postgres factory for ${name}`);
  }
  return config.postgres;
}

class FakeNotificationsPostgresPool {
  readonly queries: string[] = [];

  constructor(
    private readonly preferences: NotificationPreferenceRecord[],
    private readonly notifications: NotificationRecord[],
  ) {}

  query(sql: string, params: unknown[]): Promise<PgQueryResult> {
    this.queries.push(sql);

    if (sql === 'SELECT * FROM "NotificationPreference" WHERE "userId" = $1') {
      const userId = String(params[0]);
      return Promise.resolve({
        rows: this.preferences.filter(row => row.userId === userId),
      });
    }

    if (
      sql ===
      'SELECT * FROM "Notification" WHERE dispatched = false AND "deliverAt" IS NOT NULL AND "deliverAt" <= $1 ORDER BY "deliverAt" ASC LIMIT $2'
    ) {
      const now = params[0] instanceof Date ? params[0] : new Date(String(params[0]));
      const limit = Number(params[1]);
      const rows = this.notifications
        .filter(row => !row.dispatched && row.deliverAt != null && new Date(row.deliverAt) <= now)
        .sort(
          (left, right) =>
            new Date(left.deliverAt ?? 0).getTime() - new Date(right.deliverAt ?? 0).getTime(),
        )
        .slice(0, limit);
      return Promise.resolve({ rows });
    }

    if (
      sql ===
      'SELECT COUNT(*)::int AS count FROM "Notification" WHERE dispatched = false AND ("deliverAt" IS NULL OR "deliverAt" <= $1)'
    ) {
      const now = params[0] instanceof Date ? params[0] : new Date(String(params[0]));
      const count = this.notifications.filter(
        row =>
          !row.dispatched &&
          (row.deliverAt == null || new Date(row.deliverAt as Date | string) <= now),
      ).length;
      return Promise.resolve({ rows: [{ count }] });
    }

    if (sql === 'UPDATE "Notification" SET dispatched = true, "dispatchedAt" = $1 WHERE id = $2') {
      const dispatchedAt = params[0] instanceof Date ? params[0] : new Date(String(params[0]));
      const id = String(params[1]);
      const row = this.notifications.find(entry => entry.id === id);
      if (row) {
        const mutable = row as { dispatched: boolean; dispatchedAt: Date | null };
        mutable.dispatched = true;
        mutable.dispatchedAt = dispatchedAt;
      }
      return Promise.resolve({ rows: [] });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

describe('slingshot-notifications postgres handlers', () => {
  test('resolveForNotification postgres handler returns only matching user preferences', async () => {
    const pool = new FakeNotificationsPostgresPool(
      [
        {
          id: 'pref-1',
          userId: 'user-1',
          tenantId: null,
          scope: 'global',
          source: null,
          type: null,
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: null,
          quietEnd: null,
          updatedAt: new Date('2026-04-18T10:00:00.000Z'),
        },
        {
          id: 'pref-2',
          userId: 'user-2',
          tenantId: null,
          scope: 'source',
          source: 'chat',
          type: null,
          muted: false,
          pushEnabled: false,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: null,
          quietEnd: null,
          updatedAt: new Date('2026-04-18T11:00:00.000Z'),
        },
      ],
      [],
    );

    const factory = requirePostgresFactory(
      notificationPreferenceOperations.operations.resolveForNotification,
      'resolveForNotification',
    );
    const resolveForNotification = factory(pool);
    const rows = await resolveForNotification({ userId: 'user-1' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('pref-1');
    expect(pool.queries).toContain('SELECT * FROM "NotificationPreference" WHERE "userId" = $1');
  });

  test('listPendingDispatch postgres handler filters, sorts, and limits due notifications', async () => {
    const pool = new FakeNotificationsPostgresPool(
      [],
      [
        {
          id: 'n-late',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: 'chat:message',
          targetId: 'm-1',
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:05:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T09:00:00.000Z'),
        },
        {
          id: 'n-earliest',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: 'chat:message',
          targetId: 'm-2',
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:01:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'high',
          createdAt: new Date('2026-04-18T08:55:00.000Z'),
        },
        {
          id: 'n-future',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: 'chat:message',
          targetId: 'm-3',
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T10:30:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T10:00:00.000Z'),
        },
        {
          id: 'n-done',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: 'chat:message',
          targetId: 'm-4',
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:00:00.000Z'),
          dispatched: true,
          dispatchedAt: new Date('2026-04-18T09:10:00.000Z'),
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T08:50:00.000Z'),
        },
      ],
    );

    const factory = requirePostgresFactory(
      notificationOperations.operations.listPendingDispatch,
      'listPendingDispatch',
    );
    const listPendingDispatch = factory(pool);
    const rows = await listPendingDispatch({
      limit: 2,
      now: new Date('2026-04-18T09:10:00.000Z'),
    });

    expect(rows.map(row => row.id)).toEqual(['n-earliest', 'n-late']);
    expect(pool.queries).toContain(
      'SELECT * FROM "Notification" WHERE dispatched = false AND "deliverAt" IS NOT NULL AND "deliverAt" <= $1 ORDER BY "deliverAt" ASC LIMIT $2',
    );
  });

  test('countPendingDispatch postgres handler returns exact count of due, undispatched rows', async () => {
    const pool = new FakeNotificationsPostgresPool(
      [],
      [
        {
          id: 'n-due-1',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: null,
          targetId: null,
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:00:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T08:55:00.000Z'),
        },
        {
          id: 'n-due-2',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: null,
          targetId: null,
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:05:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T08:56:00.000Z'),
        },
        {
          id: 'n-immediate',
          userId: 'user-2',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: null,
          targetId: null,
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          // deliverAt: null — counts as immediately due.
          deliverAt: null,
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T09:00:00.000Z'),
        },
        {
          id: 'n-future',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: null,
          targetId: null,
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T10:30:00.000Z'),
          dispatched: false,
          dispatchedAt: null,
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T10:00:00.000Z'),
        },
        {
          id: 'n-already-dispatched',
          userId: 'user-1',
          tenantId: null,
          source: 'chat',
          type: 'chat:mention',
          actorId: null,
          targetType: null,
          targetId: null,
          dedupKey: null,
          data: undefined,
          read: false,
          readAt: null,
          deliverAt: new Date('2026-04-18T09:00:00.000Z'),
          dispatched: true,
          dispatchedAt: new Date('2026-04-18T09:01:00.000Z'),
          scopeId: null,
          priority: 'normal',
          createdAt: new Date('2026-04-18T08:55:00.000Z'),
        },
      ],
    );

    const factory = requirePostgresFactory(
      notificationOperations.operations.countPendingDispatch,
      'countPendingDispatch',
    );
    const countPendingDispatch = factory(pool);
    const count = await countPendingDispatch({
      now: new Date('2026-04-18T09:10:00.000Z'),
    });

    // Three rows are pending: n-due-1, n-due-2, n-immediate (null deliverAt).
    // n-future and n-already-dispatched are excluded.
    expect(count).toBe(3);
    expect(pool.queries).toContain(
      'SELECT COUNT(*)::int AS count FROM "Notification" WHERE dispatched = false AND ("deliverAt" IS NULL OR "deliverAt" <= $1)',
    );
  });

  test('markDispatched postgres handler updates dispatched state', async () => {
    const notification: NotificationRecord = {
      id: 'n-1',
      userId: 'user-1',
      tenantId: null,
      source: 'chat',
      type: 'chat:mention',
      actorId: null,
      targetType: 'chat:message',
      targetId: 'm-1',
      dedupKey: null,
      data: undefined,
      read: false,
      readAt: null,
      deliverAt: new Date('2026-04-18T09:00:00.000Z'),
      dispatched: false,
      dispatchedAt: null,
      scopeId: null,
      priority: 'normal',
      createdAt: new Date('2026-04-18T08:55:00.000Z'),
    };
    const pool = new FakeNotificationsPostgresPool([], [notification]);

    const factory = requirePostgresFactory(
      notificationOperations.operations.markDispatched,
      'markDispatched',
    );
    const markDispatched = factory(pool);
    const dispatchedAt = new Date('2026-04-18T09:11:00.000Z');

    await markDispatched({ id: 'n-1', dispatchedAt });

    expect(notification.dispatched).toBe(true);
    expect(notification.dispatchedAt).toEqual(dispatchedAt);
    expect(pool.queries).toContain(
      'UPDATE "Notification" SET dispatched = true, "dispatchedAt" = $1 WHERE id = $2',
    );
  });
});

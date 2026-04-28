import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import type { NotificationRecord } from '../types';

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function extractMemoryRow(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value['record'];
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : value;
}

function materializeNotificationRecord(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    userId: String(row.userId),
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : null,
    source: String(row.source),
    type: String(row.type),
    actorId: typeof row.actorId === 'string' ? row.actorId : null,
    targetType: typeof row.targetType === 'string' ? row.targetType : null,
    targetId: typeof row.targetId === 'string' ? row.targetId : null,
    dedupKey: typeof row.dedupKey === 'string' ? row.dedupKey : null,
    data:
      row.data && typeof row.data === 'object'
        ? (row.data as Readonly<Record<string, unknown>>)
        : undefined,
    read: row.read === true,
    readAt: row.readAt instanceof Date || typeof row.readAt === 'string' ? row.readAt : null,
    deliverAt:
      row.deliverAt instanceof Date || typeof row.deliverAt === 'string' ? row.deliverAt : null,
    dispatched: row.dispatched === true,
    dispatchedAt:
      row.dispatchedAt instanceof Date || typeof row.dispatchedAt === 'string'
        ? row.dispatchedAt
        : null,
    scopeId: typeof row.scopeId === 'string' ? row.scopeId : null,
    priority:
      row.priority === 'low' ||
      row.priority === 'normal' ||
      row.priority === 'high' ||
      row.priority === 'urgent'
        ? row.priority
        : 'normal',
    createdAt:
      row.createdAt instanceof Date || typeof row.createdAt === 'string'
        ? row.createdAt
        : new Date(0),
  };
}

/**
 * Shared notification entity.
 */
export const Notification = defineEntity('Notification', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    tenantId: field.string({ optional: true, immutable: true }),
    source: field.string({ immutable: true }),
    type: field.string({ immutable: true }),
    actorId: field.string({ optional: true, immutable: true }),
    targetType: field.string({ optional: true, immutable: true }),
    targetId: field.string({ optional: true, immutable: true }),
    dedupKey: field.string({ optional: true, immutable: true }),
    data: field.json({ optional: true }),
    read: field.boolean({ default: false }),
    readAt: field.date({ optional: true }),
    deliverAt: field.date({ optional: true, immutable: true }),
    dispatched: field.boolean({ default: false }),
    dispatchedAt: field.date({ optional: true }),
    scopeId: field.string({ optional: true, immutable: true }),
    priority: field.enum(['low', 'normal', 'high', 'urgent'] as const, { default: 'normal' }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['userId', 'createdAt'], { direction: 'desc' }),
    index(['userId', 'read']),
    index(['userId', 'source', 'read']),
    index(['userId', 'source', 'scopeId', 'read']),
    index(['userId', 'dedupKey']),
    index(['dispatched', 'deliverAt']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    list: {},
    disable: ['create', 'update', 'delete', 'get'],
    operations: {
      listByUser: {},
      listUnread: {},
      markRead: {
        event: {
          key: 'notifications:notification.read',
          exposure: ['client-safe', 'tenant-webhook', 'user-webhook'],
          scope: {
            tenantId: 'ctx:tenantId',
            userId: 'ctx:userId',
            actorId: 'ctx:actorId',
          },
        },
      },
      markAllRead: {
        event: {
          key: 'notifications:notification.updated',
          exposure: ['client-safe', 'tenant-webhook', 'user-webhook'],
          scope: {
            tenantId: 'ctx:tenantId',
            userId: 'ctx:userId',
            actorId: 'ctx:actorId',
          },
        },
      },
      unreadCount: {},
      unreadCountBySource: {},
      unreadCountByScope: {},
      hasUnreadByDedupKey: {},
    },
  },
});

/**
 * Notification named operations.
 */
export const notificationOperations = defineOperations(Notification, {
  listByUser: op.lookup({
    fields: { userId: 'param:actor.id' },
    returns: 'many',
  }),

  listUnread: op.lookup({
    fields: { userId: 'param:actor.id' },
    check: { read: false },
    returns: 'many',
  }),

  markRead: op.fieldUpdate({
    match: { id: 'param:id', userId: 'param:actor.id' },
    set: ['read', 'readAt'],
  }),

  markAllRead: op.batch({
    action: 'update',
    filter: { userId: 'param:actor.id', read: false },
    set: { read: true, readAt: 'now' },
    returns: 'count',
  }),

  unreadCount: op.aggregate({
    compute: { count: 'count' },
    filter: { userId: 'param:actor.id', read: false },
  }),

  unreadCountBySource: op.aggregate({
    compute: { count: 'count' },
    filter: { userId: 'param:actor.id', source: 'param:source', read: false },
  }),

  unreadCountByScope: op.aggregate({
    compute: { count: 'count' },
    filter: {
      userId: 'param:actor.id',
      source: 'param:source',
      scopeId: 'param:scopeId',
      read: false,
    },
  }),

  hasUnreadByDedupKey: op.exists({
    fields: { userId: 'param:actor.id', dedupKey: 'param:dedupKey' },
    check: { read: false },
  }),

  findByDedupKey: op.lookup({
    fields: { userId: 'param:userId', dedupKey: 'param:dedupKey' },
    returns: 'one',
  }),

  /**
   * Atomic dedup-or-create. See `NotificationAdapter.dedupOrCreate` for the
   * full contract. Each backend implementation below is responsible for
   * eliminating the find-then-update race that would otherwise let two
   * concurrent notify() calls insert duplicate rows for the same dedupKey.
   */
  dedupOrCreate: op.custom<
    (args: {
      userId: string;
      dedupKey: string;
      create: Record<string, unknown>;
    }) => Promise<{ record: NotificationRecord; created: boolean }>
  >({
    memory:
      store =>
      ({ userId, dedupKey, create }) => {
        // Synchronous scan + mutate in a single tick — the JavaScript event
        // loop guarantees no other microtask runs between the scan and the
        // store.set() below, so concurrent callers see at most one create.
        for (const value of store.values()) {
          const row = materializeNotificationRecord(extractMemoryRow(value));
          if (row.userId !== userId || row.dedupKey !== dedupKey || row.read) continue;
          const existingData = (row.data ?? {}) as Record<string, unknown>;
          const currentCount =
            typeof existingData['count'] === 'number' && Number.isFinite(existingData['count'])
              ? (existingData['count'] as number)
              : 1;
          const nextData = { ...existingData, count: currentCount + 1 };
          const entry = value as { record: Record<string, unknown>; expiresAt?: number };
          entry.record = { ...entry.record, data: nextData };
          store.set(row.id, entry);
          return Promise.resolve({
            record: materializeNotificationRecord({ ...entry.record }),
            created: false,
          });
        }
        // No matching unread row — insert. We synthesize a primary key here
        // because the upstream caller does not know about it.
        const id =
          typeof create['id'] === 'string' && create['id'].length > 0
            ? (create['id'] as string)
            : crypto.randomUUID();
        const record = { ...create, id };
        store.set(id, { record });
        return Promise.resolve({
          record: materializeNotificationRecord(record),
          created: true,
        });
      },
    sqlite:
      db =>
      ({ userId, dedupKey, create }) => {
        const database = db as {
          transaction(fn: () => unknown): () => unknown;
          prepare(sql: string): {
            get(...args: unknown[]): unknown;
            run(...args: unknown[]): unknown;
          };
        };
        const exec = database.transaction(() => {
          const existing = database
            .prepare(
              'SELECT * FROM Notification WHERE userId = ? AND dedupKey = ? AND read = 0 LIMIT 1',
            )
            .get(userId, dedupKey) as Record<string, unknown> | undefined;
          if (existing) {
            const rawData =
              typeof existing.data === 'string'
                ? (JSON.parse(existing.data) as Record<string, unknown>)
                : ((existing.data as Record<string, unknown> | null) ?? {});
            const currentCount =
              typeof rawData['count'] === 'number' && Number.isFinite(rawData['count'])
                ? (rawData['count'] as number)
                : 1;
            const nextData = { ...rawData, count: currentCount + 1 };
            database
              .prepare('UPDATE Notification SET data = ? WHERE id = ?')
              .run(JSON.stringify(nextData), existing.id);
            return {
              record: materializeNotificationRecord({ ...existing, data: nextData }),
              created: false,
            };
          }
          const id =
            typeof create['id'] === 'string' && create['id'].length > 0
              ? (create['id'] as string)
              : crypto.randomUUID();
          const record = { ...create, id };
          const columns = Object.keys(record);
          const placeholders = columns.map(() => '?').join(', ');
          const values = columns.map(c => {
            const v = (record as Record<string, unknown>)[c];
            if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
            return v;
          });
          database
            .prepare(`INSERT INTO Notification (${columns.join(', ')}) VALUES (${placeholders})`)
            .run(...values);
          return { record: materializeNotificationRecord(record), created: true };
        });
        return Promise.resolve(exec() as { record: NotificationRecord; created: boolean });
      },
    postgres:
      pool =>
      async ({ userId, dedupKey, create }) => {
        // Strategy: try INSERT ... ON CONFLICT DO NOTHING with a partial unique
        // constraint on (userId, dedupKey) WHERE read=false. If the insert
        // takes, return created=true. Otherwise atomically increment the
        // existing row's count via UPDATE ... RETURNING *.
        //
        // Because the partial unique index may not yet exist on legacy
        // databases, we wrap both statements in a SERIALIZABLE transaction so
        // even without the index the find+update is atomic with the insert.
        const client = pool as {
          connect(): Promise<{
            query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
            release(): void;
          }>;
        };
        const conn = await client.connect();
        try {
          await conn.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          const existingResult = await conn.query(
            'SELECT * FROM "Notification" WHERE "userId" = $1 AND "dedupKey" = $2 AND read = false LIMIT 1 FOR UPDATE',
            [userId, dedupKey],
          );
          const existing = existingResult.rows[0];
          if (existing) {
            const rawData =
              existing['data'] && typeof existing['data'] === 'object'
                ? (existing['data'] as Record<string, unknown>)
                : {};
            const currentCount =
              typeof rawData['count'] === 'number' && Number.isFinite(rawData['count'])
                ? (rawData['count'] as number)
                : 1;
            const nextData = { ...rawData, count: currentCount + 1 };
            const updated = await conn.query(
              'UPDATE "Notification" SET data = $1 WHERE id = $2 RETURNING *',
              [nextData, existing['id']],
            );
            await conn.query('COMMIT');
            return {
              record: materializeNotificationRecord(
                updated.rows[0] ?? { ...existing, data: nextData },
              ),
              created: false,
            };
          }
          const id =
            typeof create['id'] === 'string' && create['id'].length > 0
              ? (create['id'] as string)
              : crypto.randomUUID();
          const record = { ...create, id };
          const columns = Object.keys(record);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const values = columns.map(c => (record as Record<string, unknown>)[c]);
          await conn.query(
            `INSERT INTO "Notification" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
            values,
          );
          await conn.query('COMMIT');
          return { record: materializeNotificationRecord(record), created: true };
        } catch (err) {
          try {
            await conn.query('ROLLBACK');
          } catch {
            // ignore — original error is more useful
          }
          throw err;
        } finally {
          conn.release();
        }
      },
    mongo:
      collection =>
      async ({ userId, dedupKey, create }) => {
        const target = collection as {
          findOneAndUpdate(query: unknown, update: unknown, options: unknown): Promise<unknown>;
          insertOne(doc: unknown): Promise<unknown>;
          findOne(query: unknown): Promise<unknown>;
        };
        const existing = (await target.findOne({ userId, dedupKey, read: false })) as Record<
          string,
          unknown
        > | null;
        if (existing) {
          const rawData =
            existing['data'] && typeof existing['data'] === 'object'
              ? (existing['data'] as Record<string, unknown>)
              : {};
          const currentCount =
            typeof rawData['count'] === 'number' && Number.isFinite(rawData['count'])
              ? (rawData['count'] as number)
              : 1;
          const updated = (await target.findOneAndUpdate(
            { _id: existing['_id'] ?? existing['id'] },
            { $set: { data: { ...rawData, count: currentCount + 1 } } },
            { returnDocument: 'after' },
          )) as Record<string, unknown> | null;
          return {
            record: materializeNotificationRecord(updated ?? existing),
            created: false,
          };
        }
        const id =
          typeof create['id'] === 'string' && create['id'].length > 0
            ? (create['id'] as string)
            : crypto.randomUUID();
        const record = { ...create, id };
        await target.insertOne(record);
        return { record: materializeNotificationRecord(record), created: true };
      },
  }),

  listPendingDispatch: op.custom<
    (args: { limit: number; now: Date; signal?: AbortSignal }) => Promise<NotificationRecord[]>
  >({
    memory:
      store =>
      ({ limit, now }) => {
        const rows: NotificationRecord[] = [];
        for (const value of store.values()) {
          const row = materializeNotificationRecord(extractMemoryRow(value));
          const deliverAt = toDate(row.deliverAt);
          if (!row.dispatched && deliverAt && deliverAt <= now) {
            rows.push(row);
          }
        }
        rows.sort((left, right) => {
          const leftAt = toDate(left.deliverAt)?.getTime() ?? 0;
          const rightAt = toDate(right.deliverAt)?.getTime() ?? 0;
          return leftAt - rightAt;
        });
        return Promise.resolve(rows.slice(0, limit));
      },
    sqlite:
      db =>
      ({ limit, now }) => {
        const database = db as { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
        return Promise.resolve(
          database
            .prepare(
              'SELECT * FROM Notification WHERE dispatched = 0 AND deliverAt IS NOT NULL AND deliverAt <= ? ORDER BY deliverAt ASC LIMIT ?',
            )
            .all(now.toISOString(), limit) as NotificationRecord[],
        );
      },
    postgres:
      pool =>
      async ({ limit, now }) => {
        const client = pool as {
          query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
        };
        const result = await client.query(
          'SELECT * FROM "Notification" WHERE dispatched = false AND "deliverAt" IS NOT NULL AND "deliverAt" <= $1 ORDER BY "deliverAt" ASC LIMIT $2',
          [now, limit],
        );
        return result.rows as NotificationRecord[];
      },
    mongo:
      collection =>
      async ({ limit, now }) => {
        const target = collection as {
          find(query: unknown): {
            sort(order: unknown): { limit(size: number): { toArray(): Promise<unknown[]> } };
          };
        };
        return (await target
          .find({ dispatched: false, deliverAt: { $ne: null, $lte: now } })
          .sort({ deliverAt: 1 })
          .limit(limit)
          .toArray()) as NotificationRecord[];
      },
  }),

  markDispatched: op.custom<(args: { id: string; dispatchedAt: Date }) => Promise<void>>({
    memory:
      store =>
      ({ id, dispatchedAt }) => {
        const entry = store.get(id) as
          | { record: Record<string, unknown>; expiresAt?: number }
          | undefined;
        if (!entry) return Promise.resolve();
        entry.record = {
          ...entry.record,
          dispatched: true,
          dispatchedAt,
        };
        store.set(id, entry);
        return Promise.resolve();
      },
    sqlite:
      db =>
      ({ id, dispatchedAt }) => {
        const database = db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
        database
          .prepare('UPDATE Notification SET dispatched = 1, dispatchedAt = ? WHERE id = ?')
          .run(dispatchedAt.toISOString(), id);
        return Promise.resolve();
      },
    postgres:
      pool =>
      async ({ id, dispatchedAt }) => {
        const client = pool as { query(sql: string, params: unknown[]): Promise<unknown> };
        await client.query(
          'UPDATE "Notification" SET dispatched = true, "dispatchedAt" = $1 WHERE id = $2',
          [dispatchedAt, id],
        );
      },
    mongo:
      collection =>
      async ({ id, dispatchedAt }) => {
        const target = collection as {
          updateOne(query: unknown, update: unknown): Promise<unknown>;
        };
        await target.updateOne({ id }, { $set: { dispatched: true, dispatchedAt } });
      },
  }),
});

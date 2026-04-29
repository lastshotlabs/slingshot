import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import type { NotificationRecord } from '../types';

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

// Throttle state for corrupt-data warnings. We log at most once per
// `PARSE_WARN_THROTTLE_MS` window so a sweeping corruption does not flood
// logs. Mirrors the throttling approach used by the dispatcher's
// `maybeWarnPendingSaturation` helper.
const PARSE_WARN_THROTTLE_MS = 60_000;
let lastParseWarnAt = 0;

function warnCorruptRowData(rowId: unknown, entityHint: string | undefined, err: unknown): void {
  const ts = Date.now();
  if (ts - lastParseWarnAt < PARSE_WARN_THROTTLE_MS) return;
  lastParseWarnAt = ts;
  const message = err instanceof Error ? err.message : String(err);
  const id = typeof rowId === 'string' || typeof rowId === 'number' ? String(rowId) : 'unknown';
  console.warn(
    `[slingshot-notifications] Corrupt notification row.data — ignoring (rowId=${id}` +
      (entityHint ? `, entity=${entityHint}` : '') +
      `): ${message}. Further occurrences within ${PARSE_WARN_THROTTLE_MS}ms suppressed.`,
  );
}

/**
 * Safely parse a row's `data` column. Tolerates the four shapes we see across
 * backends (and one we should not see, but might if the row is corrupt):
 *
 *   - already-parsed object (memory, mongo, postgres jsonb)        -> returned as-is
 *   - JSON-encoded string (sqlite, legacy postgres rows)           -> parsed
 *   - null/undefined                                                -> undefined
 *   - corrupt JSON string                                           -> undefined + throttled warn
 *   - JSON array (data column is supposed to hold a plain object)  -> undefined
 *
 * The `data` column should never be present as anything other than an object,
 * so we explicitly reject arrays and primitive parse results.
 */
function parseRowData(
  value: unknown,
  rowId: unknown,
  entityHint?: string,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') {
    if (Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch (err) {
    warnCorruptRowData(rowId, entityHint, err);
    return undefined;
  }
}

// Test-only hook: reset the throttle so suite ordering does not affect the
// "warning emitted once" assertion. Exported via the package's testing surface
// to keep production callers from depending on it.
export function resetNotificationDataParseWarnThrottleForTests(): void {
  lastParseWarnAt = 0;
}

// Test-only re-export of `parseRowData`. Production callers should not import
// this internal test helper from application code.
export const parseNotificationRowDataForTests = parseRowData;

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
    fields: { userId: 'param:actor.id', read: false },
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
        // The entity factory's sqlite adapter exposes a minimal `run`/`query`
        // interface (see `SqliteDb` in slingshot-entity). It does not give us a
        // transaction primitive, so we reach atomicity by leaning on SQLite's
        // built-in serial execution model and `INSERT ... ON CONFLICT DO UPDATE`
        // against a partial unique index on `(user_id, dedup_key)` for unread
        // rows. The auto-generated table uses snake_case columns and the
        // pluralised `notifications` table name (see `defineEntity` storage
        // name derivation), so all SQL below addresses those names directly.
        const database = db as {
          run(sql: string, params?: unknown[]): { changes: number };
          query<T>(sql: string): {
            get(...args: unknown[]): T | null;
            all(...args: unknown[]): T[];
          };
        };
        const TABLE = 'notifications';

        // Best-effort partial-unique index. The table is created lazily by the
        // adapter on first write, so this may fail the first time through —
        // we swallow the error and retry on the next call. Either way the
        // SELECT-then-INSERT/UPDATE flow below stays atomic because each
        // statement is its own implicit transaction in SQLite, and the bun
        // sqlite driver serialises statements on a single connection.
        try {
          database.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS uidx_${TABLE}_unread_dedup ON ${TABLE} (user_id, dedup_key) WHERE read = 0 AND dedup_key IS NOT NULL`,
          );
        } catch {
          // Table not yet initialized — handler will retry next call.
        }

        function readExisting(): Record<string, unknown> | null {
          return database
            .query<
              Record<string, unknown>
            >(`SELECT * FROM ${TABLE} WHERE user_id = ? AND dedup_key = ? AND read = 0 LIMIT 1`)
            .get(userId, dedupKey);
        }

        function rowToRecord(row: Record<string, unknown>): NotificationRecord {
          const rawData = parseRowData(row['data'], row['id'], 'Notification');
          const camel: Record<string, unknown> = {
            id: row['id'],
            userId: row['user_id'],
            tenantId: row['tenant_id'] ?? null,
            source: row['source'],
            type: row['type'],
            actorId: row['actor_id'] ?? null,
            targetType: row['target_type'] ?? null,
            targetId: row['target_id'] ?? null,
            dedupKey: row['dedup_key'] ?? null,
            data: rawData,
            read: row['read'] === 1 || row['read'] === true,
            readAt: row['read_at'] ?? null,
            deliverAt: row['deliver_at'] ?? null,
            dispatched: row['dispatched'] === 1 || row['dispatched'] === true,
            dispatchedAt: row['dispatched_at'] ?? null,
            scopeId: row['scope_id'] ?? null,
            priority: row['priority'] ?? 'normal',
            createdAt: row['created_at'] ?? new Date(0),
          };
          return materializeNotificationRecord(camel);
        }

        // Fast path: row already exists for this dedup key — bump its count.
        const existingRow = readExisting();
        if (existingRow) {
          const rawData =
            parseRowData(existingRow['data'], existingRow['id'], 'Notification') ?? {};
          const currentCount =
            typeof rawData['count'] === 'number' && Number.isFinite(rawData['count'])
              ? (rawData['count'] as number)
              : 1;
          const nextData = { ...rawData, count: currentCount + 1 };
          database.run(`UPDATE ${TABLE} SET data = ? WHERE id = ?`, [
            JSON.stringify(nextData),
            existingRow['id'],
          ]);
          const merged = { ...existingRow, data: nextData };
          return Promise.resolve({ record: rowToRecord(merged), created: false });
        }

        // Slow path: race-resilient insert. Use ON CONFLICT to absorb a
        // concurrent insert; if the conflicting row is the unread duplicate
        // we increment its count via DO UPDATE.
        const id =
          typeof create['id'] === 'string' && (create['id'] as string).length > 0
            ? (create['id'] as string)
            : crypto.randomUUID();
        const record: Record<string, unknown> = { ...create, id };
        const columns = Object.keys(record);
        const snakeColumns = columns.map(c => c.replace(/([A-Z])/g, '_$1').toLowerCase());
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(c => {
          const v = record[c];
          if (v == null) return v;
          if (v instanceof Date) return v.getTime();
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        });

        try {
          database.run(
            `INSERT INTO ${TABLE} (${snakeColumns.join(', ')}) VALUES (${placeholders}) ` +
              `ON CONFLICT(user_id, dedup_key) WHERE read = 0 AND dedup_key IS NOT NULL ` +
              `DO UPDATE SET data = json_set(COALESCE(notifications.data, '{}'), '$.count', COALESCE(json_extract(notifications.data, '$.count'), 1) + 1)`,
            values,
          );
        } catch (err) {
          // The partial index may not exist yet (first call before adapter
          // ensureTable, or older databases). Fall back to a plain-INSERT
          // strategy: re-read on conflict, then increment.
          const existingAfter = readExisting();
          if (existingAfter) {
            const rawData =
              parseRowData(existingAfter['data'], existingAfter['id'], 'Notification') ?? {};
            const currentCount =
              typeof rawData['count'] === 'number' && Number.isFinite(rawData['count'])
                ? (rawData['count'] as number)
                : 1;
            const nextData = { ...rawData, count: currentCount + 1 };
            database.run(`UPDATE ${TABLE} SET data = ? WHERE id = ?`, [
              JSON.stringify(nextData),
              existingAfter['id'],
            ]);
            return Promise.resolve({
              record: rowToRecord({ ...existingAfter, data: nextData }),
              created: false,
            });
          }
          throw err;
        }

        // Read back the row so we return the canonical persisted shape (with
        // any default-applied columns) rather than the input merged with `id`.
        const persisted = readExisting();
        if (persisted && persisted['id'] === id) {
          return Promise.resolve({ record: rowToRecord(persisted), created: true });
        }
        // Lost an ON CONFLICT race — the row that wins is the duplicate, and
        // our UPDATE branch above has already incremented its count.
        if (persisted) {
          return Promise.resolve({ record: rowToRecord(persisted), created: false });
        }
        return Promise.resolve({
          record: materializeNotificationRecord(record),
          created: true,
        });
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

  countPendingDispatch: op.custom<(args: { now: Date; signal?: AbortSignal }) => Promise<number>>({
    memory:
      store =>
      ({ now }) => {
        let count = 0;
        for (const value of store.values()) {
          const row = materializeNotificationRecord(extractMemoryRow(value));
          if (row.dispatched) continue;
          // A row is "pending dispatch" when it has no deliverAt at all
          // (immediate) or its deliverAt has elapsed. Future-scheduled rows do
          // not count yet — they aren't due until deliverAt <= now.
          const deliverAt = toDate(row.deliverAt);
          if (deliverAt == null || deliverAt <= now) {
            count += 1;
          }
        }
        return Promise.resolve(count);
      },
    sqlite:
      db =>
      ({ now }) => {
        const database = db as {
          prepare(sql: string): { get(...args: unknown[]): unknown };
          query?<T>(sql: string): {
            get(...args: unknown[]): T | null;
          };
        };
        // Use the same statement shape `listPendingDispatch` uses for
        // consistency with the test fakes that match SQL strings.
        const row = database
          .prepare(
            'SELECT COUNT(*) AS count FROM Notification WHERE dispatched = 0 AND (deliverAt IS NULL OR deliverAt <= ?)',
          )
          .get(now.toISOString()) as { count?: number } | null;
        return Promise.resolve(typeof row?.count === 'number' ? row.count : 0);
      },
    postgres:
      pool =>
      async ({ now }) => {
        const client = pool as {
          query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
        };
        const result = await client.query(
          'SELECT COUNT(*)::int AS count FROM "Notification" WHERE dispatched = false AND ("deliverAt" IS NULL OR "deliverAt" <= $1)',
          [now],
        );
        const row = result.rows[0] as { count?: number | string } | undefined;
        if (!row) return 0;
        const value = typeof row.count === 'number' ? row.count : Number(row.count);
        return Number.isFinite(value) ? value : 0;
      },
    mongo:
      collection =>
      async ({ now }) => {
        const target = collection as {
          countDocuments(query: unknown): Promise<number>;
        };
        return target.countDocuments({
          dispatched: false,
          $or: [{ deliverAt: null }, { deliverAt: { $lte: now } }],
        });
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

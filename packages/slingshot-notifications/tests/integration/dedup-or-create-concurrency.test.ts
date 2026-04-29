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
import type { RuntimeSqliteDatabase, StoreInfra } from '@lastshotlabs/slingshot-core';
import { notificationFactories } from '../../src/entities/factories';
import { notificationOperations } from '../../src/entities/notification';
import { createNotificationsTestAdapters } from '../../src/testing';
import type { NotificationAdapter, NotificationRecord } from '../../src/types';

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
      .query('SELECT * FROM notifications WHERE user_id = ?')
      .all(filter.userId) as Record<string, unknown>[];
    return rows.map(row => {
      const rawData =
        typeof row['data'] === 'string'
          ? (JSON.parse(row['data'] as string) as Record<string, unknown>)
          : ((row['data'] as Record<string, unknown> | null) ?? undefined);
      return {
        id: String(row['id']),
        userId: String(row['user_id']),
        tenantId: null,
        source: String(row['source']),
        type: String(row['type']),
        actorId: null,
        targetType: typeof row['target_type'] === 'string' ? row['target_type'] : null,
        targetId: typeof row['target_id'] === 'string' ? row['target_id'] : null,
        dedupKey: typeof row['dedup_key'] === 'string' ? row['dedup_key'] : null,
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
    // Schema mirrors the snake_case columns the auto-generated entity table
    // would create (see `defineEntity` storage-name derivation: `Notification`
    // → `notifications` and `toSnakeCase` field-name conversion). The
    // dedupOrCreate sqlite handler reads/writes against this exact shape.
    db.run(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        dedup_key TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
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

/**
 * Regression coverage for the entity-factory wiring path. The earlier sqlite
 * concurrency tests exercise the algorithm directly against a hand-rolled
 * schema; this suite drives `dedupOrCreate` through the real
 * `notificationFactories.sqlite(infra)` path so the columns we read/write
 * have to match the auto-generated table that the entity adapter creates.
 *
 * If the dedupOrCreate handler regresses to camelCase column names (or to
 * using a transaction/prepare API that the entity adapter does not expose),
 * this test fails immediately.
 */
function adaptForRuntimeSqlite(db: Database): RuntimeSqliteDatabase {
  // Cast bun:sqlite's typed API to a structural shim — this test file does
  // not need to honour the full SQLQueryBindings narrowing.
  type LooseStmt<T> = {
    get(...args: unknown[]): T | null;
    all(...args: unknown[]): T[];
    run(...args: unknown[]): { changes: number };
  };
  const looseDb = db as unknown as {
    run(sql: string, ...params: unknown[]): void;
    query<T>(sql: string): LooseStmt<T>;
    prepare<T>(sql: string): LooseStmt<T>;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  };
  return {
    run(sql, ...params) {
      looseDb.run(sql, ...params);
    },
    query<T>(sql: string) {
      const stmt = looseDb.query<T>(sql);
      return {
        get: (...args) => stmt.get(...args) ?? null,
        all: (...args) => stmt.all(...args),
        run: (...args) => {
          stmt.run(...args);
        },
      };
    },
    prepare<T>(sql: string) {
      const stmt = looseDb.prepare<T>(sql);
      return {
        get: (...args) => stmt.get(...args) ?? null,
        all: (...args) => stmt.all(...args),
        run: (...args) => {
          const result = stmt.run(...args);
          return { changes: result.changes };
        },
      };
    },
    transaction<T>(fn: () => T) {
      return looseDb.transaction(fn);
    },
    close() {
      looseDb.close();
    },
  };
}

function createMemorySqliteInfra(): { infra: StoreInfra; raw: Database } {
  const raw = new Database(':memory:');
  const runtimeDb = adaptForRuntimeSqlite(raw);
  const infra: StoreInfra = {
    appName: 'slingshot-notifications-test',
    getRedis: () => {
      throw new Error('redis not configured');
    },
    getMongo: () => {
      throw new Error('mongo not configured');
    },
    getSqliteDb: () => runtimeDb,
    getPostgres: () => {
      throw new Error('postgres not configured');
    },
  };
  return { infra, raw };
}

describe('NotificationAdapter.dedupOrCreate — entity-factory sqlite wiring', () => {
  let infra: StoreInfra;
  let raw: Database;
  let adapter: ReturnType<typeof notificationFactories.sqlite>;

  beforeEach(async () => {
    const env = createMemorySqliteInfra();
    infra = env.infra;
    raw = env.raw;
    adapter = notificationFactories.sqlite(infra);
    // The entity adapter creates its table lazily on the first CRUD call.
    // Custom ops (like dedupOrCreate) bypass that lazy hook because the
    // entity wiring layer does not pass `ensureTable` into custom factories
    // — see `buildSqliteOperations` in slingshot-entity. Trigger it here so
    // these tests exercise the dedupOrCreate handler against the real
    // auto-generated schema.
    await adapter.list({ limit: 1 });
  });

  afterEach(() => {
    raw.close();
  });

  test('uses snake_case columns from the auto-generated entity schema', async () => {
    const userId = 'user-factory-1';
    const dedupKey = 'factory:thread-7';

    // First call seeds the row (and triggers the adapter's lazy ensureTable).
    const first = await adapter.dedupOrCreate({
      userId,
      dedupKey,
      create: {
        userId,
        dedupKey,
        source: 'community',
        type: 'community:mention',
        targetType: 'community:thread',
        targetId: 'thread-7',
        priority: 'normal',
        read: false,
        dispatched: false,
        data: { idx: 0 },
        createdAt: new Date(),
      },
    });

    expect(first.created).toBe(true);

    // The auto-generated table is `notifications` with snake_case columns.
    // If the dedup handler regresses to camelCase columns, this query fails.
    const rows = raw
      .query('SELECT user_id, dedup_key FROM notifications WHERE user_id = ?')
      .all(userId) as Array<{ user_id: string; dedup_key: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userId);
    expect(rows[0]!.dedup_key).toBe(dedupKey);
  });

  test('collapses N concurrent calls through the entity adapter into one row', async () => {
    const userId = 'user-factory-2';
    const dedupKey = 'factory:thread-9';

    // Seed first (sequentially) so the lazy ensureTable + index creation runs
    // before the concurrent burst, then race the rest of the increments.
    await adapter.dedupOrCreate({
      userId,
      dedupKey,
      create: {
        userId,
        dedupKey,
        source: 'community',
        type: 'community:mention',
        targetType: 'community:thread',
        targetId: 'thread-9',
        priority: 'normal',
        read: false,
        dispatched: false,
        data: { idx: 0 },
        createdAt: new Date(),
      },
    });

    const remaining = CONCURRENCY - 1;
    const calls = Array.from({ length: remaining }, (_, i) =>
      adapter.dedupOrCreate({
        userId,
        dedupKey,
        create: {
          userId,
          dedupKey,
          source: 'community',
          type: 'community:mention',
          targetType: 'community:thread',
          targetId: 'thread-9',
          priority: 'normal',
          read: false,
          dispatched: false,
          data: { idx: i + 1 },
          createdAt: new Date(),
        },
      }),
    );
    const results = await Promise.all(calls);

    // Every concurrent caller after the first must observe `created: false`.
    expect(results.every(r => !r.created)).toBe(true);

    const stored = raw
      .query('SELECT id, data FROM notifications WHERE user_id = ?')
      .all(userId) as Array<{ id: string; data: string | null }>;
    expect(stored).toHaveLength(1);

    const persistedData =
      typeof stored[0]!.data === 'string'
        ? (JSON.parse(stored[0]!.data) as { count?: number })
        : (stored[0]!.data as { count?: number } | null);
    expect(persistedData?.count).toBe(CONCURRENCY);
  });
});

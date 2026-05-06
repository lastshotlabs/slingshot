/**
 * Regression coverage for the sqlite dispatcher-path ops:
 * `listPendingDispatch`, `countPendingDispatch`, `markDispatched`, and the
 * preference adapter's `resolveForNotification`.
 *
 * These ops drive the periodic dispatcher tick, and they all bypass the
 * entity adapter's `fromRow` mapper because the entity wiring layer does not
 * pass `fromRow` into `op.custom` factories. That means each handler owns
 * its own SQL — and historically each one drifted out of sync with the
 * auto-generated table/column names produced by `defineEntity`. A regression
 * here surfaces at runtime as either `database.prepare is not a function`
 * (using a method that isn't on the entity's `SqliteDb` contract) or
 * `no such table: Notification` / `no such column: deliverAt` (camelCase
 * names against a snake_case schema).
 *
 * This suite drives every dispatcher-path op through the real
 * `notificationFactories.sqlite(infra)` / `notificationPreferenceFactories.sqlite(infra)`
 * wiring so the SQL has to match the schema the adapter actually creates.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RuntimeSqliteDatabase, StoreInfra } from '@lastshotlabs/slingshot-core';
import {
  notificationFactories,
  notificationPreferenceFactories,
} from '../../src/entities/factories';

function adaptForRuntimeSqlite(db: Database): RuntimeSqliteDatabase {
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

describe('Notification dispatcher-path sqlite ops — entity-factory wiring', () => {
  let infra: StoreInfra;
  let raw: Database;
  let notifications: ReturnType<typeof notificationFactories.sqlite>;

  beforeEach(async () => {
    const env = createMemorySqliteInfra();
    infra = env.infra;
    raw = env.raw;
    notifications = notificationFactories.sqlite(infra);
    // Force the adapter's lazy ensureTable() so the custom ops see a real
    // `notifications` table when they run.
    await notifications.list({ limit: 1 });
  });

  afterEach(() => {
    raw.close();
  });

  test('listPendingDispatch returns due, undispatched rows ordered by deliverAt', async () => {
    const past = new Date('2026-04-18T09:00:00.000Z');
    const olderPast = new Date('2026-04-18T08:00:00.000Z');
    const future = new Date('2030-01-01T00:00:00.000Z');

    await notifications.create({
      userId: 'user-1',
      source: 'chat',
      type: 'chat:mention',
      deliverAt: past,
    });
    await notifications.create({
      userId: 'user-2',
      source: 'chat',
      type: 'chat:reply',
      deliverAt: olderPast,
    });
    await notifications.create({
      userId: 'user-3',
      source: 'chat',
      type: 'chat:later',
      deliverAt: future,
    });

    const result = await notifications.listPendingDispatch({
      limit: 10,
      now: new Date('2026-04-18T10:00:00.000Z'),
    });

    expect(result.records).toHaveLength(2);
    // olderPast comes first by deliverAt ASC.
    expect(result.records[0]?.userId).toBe('user-2');
    expect(result.records[1]?.userId).toBe('user-1');
    // Records must be returned with camelCase fields (snake_case columns
    // mapped back to NotificationRecord shape).
    expect(result.records[0]?.deliverAt).toBeInstanceOf(Date);
    expect(result.records[0]?.dispatched).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  test('listPendingDispatch supports cursor pagination', async () => {
    for (let i = 0; i < 3; i += 1) {
      await notifications.create({
        userId: `user-${i}`,
        source: 'chat',
        type: 'chat:mention',
        deliverAt: new Date(`2026-04-18T09:0${i}:00.000Z`),
      });
    }

    const now = new Date('2026-04-18T10:00:00.000Z');
    const page1 = await notifications.listPendingDispatch({ limit: 1, now });
    expect(page1.records).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await notifications.listPendingDispatch({
      limit: 1,
      now,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.records).toHaveLength(1);
    expect(page2.records[0]?.id).not.toBe(page1.records[0]?.id);
  });

  test('countPendingDispatch returns the exact count of due, undispatched rows', async () => {
    const past = new Date('2026-04-18T09:00:00.000Z');
    const future = new Date('2030-01-01T00:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await notifications.create({
        userId: `due-${i}`,
        source: 'chat',
        type: 'chat:mention',
        deliverAt: past,
      });
    }
    await notifications.create({
      userId: 'future-1',
      source: 'chat',
      type: 'chat:later',
      deliverAt: future,
    });
    // No deliverAt at all — counts as immediate (NULL deliverAt is "due").
    await notifications.create({
      userId: 'immediate-1',
      source: 'chat',
      type: 'chat:now',
    });

    const count = await notifications.countPendingDispatch({
      now: new Date('2026-04-18T10:00:00.000Z'),
    });
    expect(count).toBe(4);
  });

  test('markDispatched flips a row to dispatched=true and stops listPendingDispatch returning it', async () => {
    const past = new Date('2026-04-18T09:00:00.000Z');
    const created = await notifications.create({
      userId: 'user-1',
      source: 'chat',
      type: 'chat:mention',
      deliverAt: past,
    });

    await notifications.markDispatched({ id: created.id, dispatchedAt: new Date() });

    const stillPending = await notifications.listPendingDispatch({
      limit: 10,
      now: new Date('2026-04-18T10:00:00.000Z'),
    });
    expect(stillPending.records).toHaveLength(0);

    const refetched = await notifications.getById(created.id);
    expect(refetched?.dispatched).toBe(true);
    expect(refetched?.dispatchedAt).toBeInstanceOf(Date);
  });
});

describe('NotificationPreference.resolveForNotification — entity-factory sqlite wiring', () => {
  let infra: StoreInfra;
  let raw: Database;
  let preferences: ReturnType<typeof notificationPreferenceFactories.sqlite>;

  beforeEach(async () => {
    const env = createMemorySqliteInfra();
    infra = env.infra;
    raw = env.raw;
    preferences = notificationPreferenceFactories.sqlite(infra);
    await preferences.list({ limit: 1 });
  });

  afterEach(() => {
    raw.close();
  });

  test('returns user preferences with snake_case columns mapped back to camelCase', async () => {
    await preferences.create({
      userId: 'user-1',
      scope: 'global',
      muted: true,
      pushEnabled: false,
      quietStart: '22:00',
      quietEnd: '06:00',
    });
    await preferences.create({
      userId: 'user-1',
      scope: 'source',
      source: 'community',
    });
    await preferences.create({
      userId: 'user-2',
      scope: 'global',
    });

    const rows = await preferences.resolveForNotification({ userId: 'user-1' });
    expect(rows).toHaveLength(2);
    const globalPref = rows.find(r => r.scope === 'global');
    expect(globalPref).toBeDefined();
    expect(globalPref?.muted).toBe(true);
    expect(globalPref?.pushEnabled).toBe(false);
    expect(globalPref?.quietStart).toBe('22:00');
    expect(globalPref?.quietEnd).toBe('06:00');
    const sourcePref = rows.find(r => r.scope === 'source');
    expect(sourcePref?.source).toBe('community');
  });
});

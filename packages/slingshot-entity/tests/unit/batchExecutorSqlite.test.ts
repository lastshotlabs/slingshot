// Regression tests for the sqlite batch executor's value binding.
//
// `set: { field: 'now' }` resolves to a Date object in the shared
// resolveSetValue helper; bun:sqlite cannot bind Date instances, so any
// batch update op using 'now' (e.g. Notification.markAllRead's
// `set: { read: true, readAt: 'now' }`) threw
// "TypeError: Binding expected string, TypedArray, boolean, number, bigint
// or null" and 500'd the route. Date columns store epoch ms in sqlite, so
// the executor must bind `getTime()` (mirroring the transition executor's
// sqlite branch).
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { batchSqlite } from '../../src/configDriven/operationExecutors/batch';
import type { BatchOpConfig } from '../../src/configDriven/operations';

function makeDb() {
  const raw = new Database(':memory:');
  raw.run(
    'CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, read INTEGER, read_at INTEGER)',
  );
  raw.run("INSERT INTO notifications VALUES ('n1', 'u1', 0, NULL)");
  raw.run("INSERT INTO notifications VALUES ('n2', 'u1', 0, NULL)");
  raw.run("INSERT INTO notifications VALUES ('n3', 'u2', 0, NULL)");
  const db = {
    run(sql: string, params?: unknown[]) {
      return raw.run(sql, ...((params ?? []) as never[]));
    },
    query<T>(sql: string) {
      return raw.query<T, never[]>(sql);
    },
  };
  return { raw, db };
}

const config = { name: 'Notification' } as unknown as ResolvedEntityConfig;

describe('batchSqlite — set value binding', () => {
  test("set: { readAt: 'now' } binds epoch ms, not a Date object", async () => {
    const { raw, db } = makeDb();
    const op: BatchOpConfig = {
      kind: 'batch',
      action: 'update',
      filter: { userId: 'param:userId', read: false },
      set: { read: true, readAt: 'now' },
    } as BatchOpConfig;
    const exec = batchSqlite(op, config, db as never, 'notifications', () => {});

    const before = Date.now();
    const changed = await exec({ userId: 'u1' });
    const after = Date.now();

    expect(changed).toBe(2);
    const rows = raw
      .query<
        { id: string; read: number; read_at: number | null },
        never[]
      >('SELECT id, read, read_at FROM notifications ORDER BY id')
      .all();
    expect(rows[0]).toMatchObject({ id: 'n1', read: 1 });
    expect(rows[0]!.read_at).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.read_at).toBeLessThanOrEqual(after);
    // u2's row untouched
    expect(rows[2]).toMatchObject({ id: 'n3', read: 0, read_at: null });
  });
});

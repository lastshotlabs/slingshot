/**
 * Defensive parsing tests for `Notification` entity row.data.
 *
 * The `data` column is JSON-encoded by the sqlite backend and stored as a
 * native object by memory/mongo/postgres-jsonb backends. If a row is
 * corrupted (manual edit, schema-mismatched writer, partial truncation), we
 * must not let that take down the entire notification system. The fix in
 * `src/entities/notification.ts` routes all reads through `parseRowData`,
 * which:
 *
 *   - returns objects unchanged
 *   - parses JSON-encoded strings
 *   - returns `undefined` for null, arrays, or unparseable input
 *   - emits a single throttled warning per minute when input is corrupt
 *
 * This file exercises every one of those branches via the `__`-prefixed
 * test-only export, plus an end-to-end check that reading a row whose `data`
 * column was hand-poisoned with bad JSON via the sqlite backend does not
 * throw and merely yields `data: undefined`.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  parseNotificationRowDataForTests as parseRowData,
  resetNotificationDataParseWarnThrottleForTests as resetWarnThrottle,
} from '../src/entities/notification';

describe('parseRowData', () => {
  let warnCalls: unknown[][];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    resetWarnThrottle();
  });

  afterEach(() => {
    console.warn = originalWarn;
    resetWarnThrottle();
  });

  test('parses a valid JSON string into an object', () => {
    const result = parseRowData('{"count":3,"label":"hi"}', 'row-1');
    expect(result).toEqual({ count: 3, label: 'hi' });
    expect(warnCalls).toHaveLength(0);
  });

  test('returns an already-parsed object unchanged', () => {
    const input = { count: 5, nested: { ok: true } };
    const result = parseRowData(input, 'row-2');
    // The helper returns the same reference — mutation by callers must be
    // handled at the call site, not here. The contract is "object passes
    // through".
    expect(result).toBe(input);
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined and warns once on corrupt JSON string', () => {
    const result = parseRowData('{"count":', 'row-3', 'Notification');
    expect(result).toBeUndefined();
    expect(warnCalls).toHaveLength(1);
    const message = String(warnCalls[0]?.[0] ?? '');
    expect(message).toContain('[slingshot-notifications]');
    expect(message).toContain('row-3');
    expect(message).toContain('Notification');
  });

  test('throttles repeated corrupt warnings to once per minute', () => {
    parseRowData('{not json', 'row-a');
    parseRowData('also not json', 'row-b');
    parseRowData('still bad', 'row-c');
    // All three rows are corrupt, but the throttle collapses them into one.
    expect(warnCalls).toHaveLength(1);
  });

  test('returns undefined for an array (data column must be an object)', () => {
    const result = parseRowData([1, 2, 3], 'row-4');
    expect(result).toBeUndefined();
    // Arrays are a structured-but-wrong shape, not corruption — no warn.
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined for a JSON-encoded array string', () => {
    const result = parseRowData('[1,2,3]', 'row-5');
    expect(result).toBeUndefined();
    // Valid JSON, just the wrong outer shape — no warn.
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined for a JSON-encoded primitive', () => {
    expect(parseRowData('"just a string"', 'row-6')).toBeUndefined();
    expect(parseRowData('42', 'row-7')).toBeUndefined();
    expect(parseRowData('null', 'row-8')).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined for null', () => {
    expect(parseRowData(null, 'row-9')).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined for undefined', () => {
    expect(parseRowData(undefined, 'row-10')).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });

  test('returns undefined for non-string non-object scalars', () => {
    expect(parseRowData(42, 'row-11')).toBeUndefined();
    expect(parseRowData(true, 'row-12')).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });
});

describe('parseRowData — sqlite dedupOrCreate end-to-end', () => {
  // Smoke test that a row whose `data` column has been hand-poisoned with
  // corrupt JSON does not crash the dedup-or-create read path. We use the
  // sqlite handler directly because that is the backend that actually
  // round-trips JSON through a string column.
  let db: Database;
  let originalWarn: typeof console.warn;

  beforeEach(async () => {
    db = new Database(':memory:');
    originalWarn = console.warn;
    console.warn = () => {
      /* swallow during test */
    };
    resetWarnThrottle();
  });

  afterEach(() => {
    db.close();
    console.warn = originalWarn;
    resetWarnThrottle();
  });

  test('reading a row with corrupt data does not throw', async () => {
    const { notificationOperations } = await import('../src/entities/notification');
    // `defineOperations` returns `{ entityConfig, operations }`. The
    // per-backend handler factories live on the operation config under their
    // backend name.
    const dedup = (
      notificationOperations as unknown as {
        operations: { dedupOrCreate: { sqlite: unknown } };
      }
    ).operations.dedupOrCreate;
    const sqliteFactory = dedup.sqlite as (
      db: unknown,
    ) => (args: {
      userId: string;
      dedupKey: string;
      create: Record<string, unknown>;
    }) => Promise<{ record: unknown; created: boolean }>;

    // Adapter shape expected by the handler.
    const adapter = {
      run(sql: string, params?: unknown[]) {
        return db.run(sql, ...((params ?? []) as never[]));
      },
      query<T>(sql: string) {
        const stmt = db.query(sql);
        return {
          get: (...args: unknown[]) => stmt.get(...(args as never[])) as T | null,
          all: (...args: unknown[]) => stmt.all(...(args as never[])) as T[],
        };
      },
    };

    // Hand-create the table + a row with corrupt JSON in `data`. The handler
    // tries to create the partial unique index lazily, so we set up the table
    // with the columns it expects.
    db.run(
      `CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        tenant_id TEXT,
        source TEXT,
        type TEXT,
        actor_id TEXT,
        target_type TEXT,
        target_id TEXT,
        dedup_key TEXT,
        data TEXT,
        read INTEGER DEFAULT 0,
        read_at TEXT,
        deliver_at TEXT,
        dispatched INTEGER DEFAULT 0,
        dispatched_at TEXT,
        scope_id TEXT,
        priority TEXT DEFAULT 'normal',
        created_at TEXT
      )`,
    );
    db.run(
      `INSERT INTO notifications (id, user_id, dedup_key, source, type, data, read)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['poisoned-1', 'user-x', 'key-x', 'community', 'community:mention', '{not valid json', 0],
    );

    const handler = sqliteFactory(adapter);
    const out = await handler({
      userId: 'user-x',
      dedupKey: 'key-x',
      create: {
        userId: 'user-x',
        dedupKey: 'key-x',
        source: 'community',
        type: 'community:mention',
        priority: 'normal',
        read: false,
        dispatched: false,
        data: { fresh: true },
        createdAt: new Date(),
      },
    });

    // The dedup path matched the existing (corrupt) row and bumped its
    // count — created must be false. The returned record's `data` should
    // contain the new count, with the old corrupt blob discarded.
    expect(out.created).toBe(false);
    const record = out.record as { id: string; data?: Record<string, unknown> };
    expect(record.id).toBe('poisoned-1');
    expect(record.data).toBeDefined();
    expect((record.data as { count?: number }).count).toBe(2);
  });
});

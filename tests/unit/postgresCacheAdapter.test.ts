import { beforeEach, describe, expect, test } from 'bun:test';
import type { CacheAdapter } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function createMockPool() {
  const calls: QueryCall[] = [];
  let nextResult: { rows: Record<string, unknown>[] } = { rows: [] };
  let failSql: string | null = null;
  let failTimes = 0;

  const runQuery = async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    if (failSql === normalized && failTimes > 0) {
      failTimes--;
      throw new Error(`forced failure: ${normalized}`);
    }
    return nextResult;
  };

  const client = {
    query: runQuery,
    release: () => {},
  };

  const pool = {
    query: runQuery,
    connect: async () => client,
  };

  return {
    pool: pool as unknown as import('pg').Pool,
    calls,
    setNextResult(rows: Record<string, unknown>[]) {
      nextResult = { rows };
    },
    failOn(sql: string, times = 1) {
      failSql = sql;
      failTimes = times;
    },
    reset() {
      calls.length = 0;
      nextResult = { rows: [] };
      failSql = null;
      failTimes = 0;
    },
  };
}

describe('postgresCacheAdapter', () => {
  let mock: ReturnType<typeof createMockPool>;
  let adapter: CacheAdapter;

  beforeEach(async () => {
    mock = createMockPool();
    const { createPostgresCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/postgresCacheAdapter');
    adapter = await createPostgresCacheAdapter(mock.pool);
    // Clear the init calls (CREATE TABLE + CREATE INDEX)
    mock.reset();
  });

  test('table creation on init', async () => {
    // Re-create to capture init calls
    const fresh = createMockPool();
    const { createPostgresCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/postgresCacheAdapter');
    await createPostgresCacheAdapter(fresh.pool);

    expect(fresh.calls[0].sql).toBe('BEGIN');

    const createTableCall = fresh.calls.find(c => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTableCall).toBeDefined();
    expect(createTableCall!.sql).toContain('cache_entries');

    const createIndexCall = fresh.calls.find(c => c.sql.includes('CREATE INDEX IF NOT EXISTS'));
    expect(createIndexCall).toBeDefined();
    expect(createIndexCall!.sql).toContain('idx_cache_entries_expires');
    expect(fresh.calls.at(-1)?.sql).toBe('COMMIT');
  });

  test('initialization rolls back on bootstrap failure', async () => {
    const fresh = createMockPool();
    fresh.failOn(
      'CREATE TABLE IF NOT EXISTS cache_entries ( key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TIMESTAMPTZ )',
    );
    const { createPostgresCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/postgresCacheAdapter');

    await expect(createPostgresCacheAdapter(fresh.pool)).rejects.toThrow('forced failure');
    expect(fresh.calls.map(c => c.sql)).toContain('ROLLBACK');
  });

  test('get returns value on cache hit', async () => {
    mock.setNextResult([{ value: 'cached-data' }]);
    const result = await adapter.get('session:abc');

    expect(result).toBe('cached-data');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain('SELECT value FROM cache_entries');
    expect(mock.calls[0].sql).toContain('expires_at > NOW()');
    expect(mock.calls[0].params).toEqual(['session:abc']);
  });

  test('get returns null on cache miss', async () => {
    mock.setNextResult([]);
    const result = await adapter.get('nonexistent');

    expect(result).toBeNull();
  });

  test('get returns null for expired entries (filtered in SQL)', async () => {
    // The SQL WHERE clause includes `expires_at > NOW()` which filters expired entries.
    // A miss (empty rows) means either key doesn't exist or is expired.
    mock.setNextResult([]);
    const result = await adapter.get('expired-key');

    expect(result).toBeNull();
    expect(mock.calls[0].sql).toContain('expires_at IS NULL OR expires_at > NOW()');
  });

  test('set without TTL stores null expires_at', async () => {
    await adapter.set('key1', 'value1');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain('INSERT INTO cache_entries');
    expect(mock.calls[0].sql).toContain('ON CONFLICT');
    expect(mock.calls[0].params).toEqual(['key1', 'value1', null]);
  });

  test('set with TTL stores future Date as expires_at', async () => {
    const before = Date.now();
    await adapter.set('key2', 'value2', 300);
    const after = Date.now();

    expect(mock.calls).toHaveLength(1);
    const expiresAt = mock.calls[0].params![2] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    // Should be ~300 seconds in the future
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 300 * 1000);
  });

  test('del removes the key', async () => {
    await adapter.del('key1');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain('DELETE FROM cache_entries WHERE key = $1');
    expect(mock.calls[0].params).toEqual(['key1']);
  });

  test('delPattern converts glob to LIKE pattern', async () => {
    await adapter.delPattern('session:*');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain("DELETE FROM cache_entries WHERE key LIKE $1 ESCAPE '\\'");
    expect(mock.calls[0].params).toEqual(['session:%']);
  });

  test('delPattern escapes LIKE metacharacters', async () => {
    await adapter.delPattern('rate%limit_key');

    expect(mock.calls).toHaveLength(1);
    // % and _ in the original pattern should be escaped
    expect(mock.calls[0].params).toEqual(['rate\\%limit\\_key']);
  });

  test('delPattern preserves literal backslash escapes for LIKE', async () => {
    await adapter.delPattern('tenant\\_cache\\%');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain("ESCAPE '\\'");
    expect(mock.calls[0].params).toEqual(['tenant\\\\\\_cache\\\\\\%']);
  });

  test('delPattern handles glob ? as single character wildcard', async () => {
    await adapter.delPattern('user:?');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].params).toEqual(['user:_']);
  });

  test('delPattern escapes backslash in pattern', async () => {
    await adapter.delPattern('path\\to\\*');

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].params).toEqual(['path\\\\to\\\\%']);
  });

  test('isReady returns true after init', () => {
    expect(adapter.isReady()).toBe(true);
  });

  test('adapter name is postgres', () => {
    expect(adapter.name).toBe('postgres');
  });

  test('background cleanup timer fires and deletes expired entries', async () => {
    // Capture the setInterval callback by temporarily overriding setInterval
    let capturedCallback: (() => Promise<void>) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const mockTimer = { unref: () => {} };

    globalThis.setInterval = (fn: TimerHandler) => {
      capturedCallback = fn as () => Promise<void>;
      return mockTimer as unknown as ReturnType<typeof setInterval>;
    };

    const fresh = createMockPool();
    const { createPostgresCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/postgresCacheAdapter');
    await createPostgresCacheAdapter(fresh.pool);

    globalThis.setInterval = originalSetInterval;

    expect(capturedCallback).not.toBeNull();

    // Trigger the cleanup callback (covers the try block at lines 69-73)
    fresh.reset();
    await capturedCallback!();

    const cleanupCall = fresh.calls.find(c =>
      c.sql.includes('DELETE FROM cache_entries WHERE expires_at IS NOT NULL'),
    );
    expect(cleanupCall).toBeDefined();
  });

  test('background cleanup timer swallows errors silently', async () => {
    // Capture the setInterval callback
    let capturedCallback: (() => Promise<void>) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const mockTimer = { unref: () => {} };

    globalThis.setInterval = (fn: TimerHandler) => {
      capturedCallback = fn as () => Promise<void>;
      return mockTimer as unknown as ReturnType<typeof setInterval>;
    };

    const fresh = createMockPool();
    // Make pool.query throw on the cleanup DELETE call
    let callCount = 0;
    const originalQuery = fresh.pool.query.bind(fresh.pool);
    (fresh.pool as any).query = async (sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount > 2) {
        // After CREATE TABLE + CREATE INDEX, throw on cleanup
        throw new Error('cleanup query failed');
      }
      return originalQuery(sql, params);
    };

    const { createPostgresCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/postgresCacheAdapter');
    await createPostgresCacheAdapter(fresh.pool);

    globalThis.setInterval = originalSetInterval;

    // Should not throw even when pool.query fails
    await expect(capturedCallback!()).resolves.toBeUndefined();
  });
});

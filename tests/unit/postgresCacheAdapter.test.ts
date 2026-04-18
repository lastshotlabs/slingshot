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

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return nextResult;
    },
  };

  return {
    pool: pool as unknown as import('pg').Pool,
    calls,
    setNextResult(rows: Record<string, unknown>[]) {
      nextResult = { rows };
    },
    reset() {
      calls.length = 0;
      nextResult = { rows: [] };
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

    const createTableCall = fresh.calls.find(c => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTableCall).toBeDefined();
    expect(createTableCall!.sql).toContain('cache_entries');

    const createIndexCall = fresh.calls.find(c => c.sql.includes('CREATE INDEX IF NOT EXISTS'));
    expect(createIndexCall).toBeDefined();
    expect(createIndexCall!.sql).toContain('idx_cache_entries_expires');
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
    expect(mock.calls[0].sql).toContain('DELETE FROM cache_entries WHERE key LIKE $1');
    expect(mock.calls[0].params).toEqual(['session:%']);
  });

  test('delPattern escapes LIKE metacharacters', async () => {
    await adapter.delPattern('rate%limit_key');

    expect(mock.calls).toHaveLength(1);
    // % and _ in the original pattern should be escaped
    expect(mock.calls[0].params).toEqual(['rate\\%limit\\_key']);
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
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import type { CacheAdapter } from '@lastshotlabs/slingshot-core';
import { createPostgresCacheAdapter } from '../../src/framework/boundaryAdapters/postgresCacheAdapter';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('Postgres cache adapter (docker)', () => {
  let pool: Pool;
  let adapter: CacheAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    adapter = await createPostgresCacheAdapter(pool);
  });

  afterAll(async () => {
    // Clean up table
    await pool.query('DROP TABLE IF EXISTS cache_entries');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM cache_entries');
  });

  it('round-trip set/get', async () => {
    await adapter.set('key1', 'value1');
    const result = await adapter.get('key1');
    expect(result).toBe('value1');
  });

  it('TTL expiry', async () => {
    await adapter.set('ttl-key', 'expires-soon', 1);
    // Immediately should be available
    const immediate = await adapter.get('ttl-key');
    expect(immediate).toBe('expires-soon');

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 1500));
    const expired = await adapter.get('ttl-key');
    expect(expired).toBeNull();
  });

  it('del removes entry', async () => {
    await adapter.set('del-key', 'val');
    expect(await adapter.get('del-key')).toBe('val');

    await adapter.del('del-key');
    expect(await adapter.get('del-key')).toBeNull();
  });

  it('delPattern glob', async () => {
    await adapter.set('a:1', 'v1');
    await adapter.set('a:2', 'v2');
    await adapter.set('b:1', 'v3');

    await adapter.delPattern('a:*');

    expect(await adapter.get('a:1')).toBeNull();
    expect(await adapter.get('a:2')).toBeNull();
    expect(await adapter.get('b:1')).toBe('v3');
  });

  it('upsert overwrites', async () => {
    await adapter.set('upsert-key', 'first');
    await adapter.set('upsert-key', 'second');

    const result = await adapter.get('upsert-key');
    expect(result).toBe('second');
  });

  it('isReady returns true after init', () => {
    expect(adapter.isReady()).toBe(true);
  });
});

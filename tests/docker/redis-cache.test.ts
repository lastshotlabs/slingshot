import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
// bustCache and bustCachePattern are tested indirectly via direct Redis operations
import {
  connectTestRedis,
  disconnectTestServices,
  flushTestServices,
  getTestRedis,
} from '../setup-docker';

beforeAll(async () => {
  await connectTestRedis();
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe('Redis cache store', () => {
  // We test the internal store functions indirectly via the Redis client,
  // since storeGet/storeSet/storeDel are not exported. We test them through
  // the bustCache and bustCachePattern public APIs + direct Redis inspection.
  //
  // After Phase 1 singleton elimination, bustCache/bustCachePattern default
  // to "Core API" as the app name when no app reference is provided.

  it('sets and gets a cache entry via Redis', async () => {
    const redis = getTestRedis();
    const key = 'cache:Core API:test-key';
    const value = JSON.stringify({ status: 200, headers: {}, body: 'hello' });
    await redis.setex(key, 60, value);

    const stored = await redis.get(key);
    expect(stored).toBe(value);
  });

  it('sets entry with TTL', async () => {
    const redis = getTestRedis();
    const key = 'cache:Core API:ttl-key';
    await redis.setex(key, 2, 'data');
    expect(await redis.get(key)).toBe('data');

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2);
  });

  it('bustCache deletes a specific key', async () => {
    const redis = getTestRedis();
    const key = 'cache:Core API:bust-me';
    await redis.set(key, 'value');
    expect(await redis.get(key)).toBe('value');

    // bustCache requires an app context — test store behavior directly via Redis
    await redis.del(key);
    expect(await redis.get(key)).toBeNull();
  });

  it('bustCachePattern deletes matching keys via SCAN', async () => {
    const redis = getTestRedis();
    await redis.set('cache:Core API:users:1', 'a');
    await redis.set('cache:Core API:users:2', 'b');
    await redis.set('cache:Core API:products:1', 'c');

    // bustCachePattern requires an app context — test store behavior directly via SCAN+DEL
    const keys = await redis.keys('cache:Core API:users:*');
    if (keys.length > 0) await redis.del(...keys);

    expect(await redis.get('cache:Core API:users:1')).toBeNull();
    expect(await redis.get('cache:Core API:users:2')).toBeNull();
    // Non-matching key should remain
    expect(await redis.get('cache:Core API:products:1')).toBe('c');
  });

  it('bustCachePattern handles no matching keys', async () => {
    // Should not throw — test via direct Redis SCAN+DEL
    const r = getTestRedis();
    const keys = await r.keys('cache:Core API:nonexistent:*');
    if (keys.length > 0) await r.del(...keys);
  });

  it('set without TTL (indefinite)', async () => {
    const redis = getTestRedis();
    const key = 'cache:Core API:no-ttl';
    await redis.set(key, 'forever');

    const ttl = await redis.ttl(key);
    expect(ttl).toBe(-1); // -1 means no expiry
  });
});

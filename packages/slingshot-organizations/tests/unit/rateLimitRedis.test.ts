import { afterEach, describe, expect, test } from 'bun:test';
import { createRedisOrganizationsRateLimitStore } from '../../src/lib/rateLimitRedis';
import type { RedisLike } from '../../src/lib/rateLimitRedis';

class MockRedis implements RedisLike {
  calls: unknown[][] = [];
  nextResult: unknown = [1, 0, 4];
  nextError: Error | null = null;

  async eval(...args: unknown[]): Promise<unknown> {
    this.calls.push(args);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextResult;
  }
}

const realDateNow = Date.now;

describe('createRedisOrganizationsRateLimitStore', () => {
  afterEach(() => {
    Date.now = realDateNow;
  });

  test('runs the sliding-window script with prefixed key and returns an allow decision', async () => {
    Date.now = () => 1_700_000_000_000;
    const redis = new MockRedis();
    redis.nextResult = [1, 0, 2];
    const store = createRedisOrganizationsRateLimitStore(redis, 'tenant-a:org-rl:');

    await expect(store.hit('invite:user-1', 5, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      remaining: 2,
    });

    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0]!.slice(1)).toEqual([
      1,
      'tenant-a:org-rl:invite:user-1',
      1_700_000_000_000,
      60_000,
      5,
    ]);
    expect(String(redis.calls[0]![0])).toContain('ZREMRANGEBYSCORE');
  });

  test('returns a deny decision with retry-after from Redis', async () => {
    const redis = new MockRedis();
    redis.nextResult = [0, 1_250, 0];
    const store = createRedisOrganizationsRateLimitStore(redis);

    await expect(store.hit('membership:create', 3, 10_000)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 1_250,
      remaining: 0,
    });
  });

  test('fails open when Redis is unavailable', async () => {
    const redis = new MockRedis();
    redis.nextError = new Error('redis unavailable');
    const store = createRedisOrganizationsRateLimitStore(redis);

    await expect(store.hit('invite:user-2', 7, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      remaining: 7,
    });
  });
});

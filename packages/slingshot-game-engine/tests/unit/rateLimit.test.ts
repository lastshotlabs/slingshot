/**
 * Unit tests for the per-player per-channel rate limiter.
 *
 * Tests createInMemoryRateLimiter sliding window behavior and
 * channelRateLimitKey composition.
 */
import { describe, expect, test } from 'bun:test';
import { channelRateLimitKey, createInMemoryRateLimiter } from '../../src/lib/rateLimit';

describe('channelRateLimitKey', () => {
  test('composes key from session, channel, userId', () => {
    const key = channelRateLimitKey('session-1', 'answers', 'alice');
    expect(key).toBe('game:rate:session-1:answers:alice');
  });

  test('handles special characters', () => {
    const key = channelRateLimitKey('s:1', 'ch:2', 'u:3');
    expect(key).toBe('game:rate:s:1:ch:2:u:3');
  });
});

describe('createInMemoryRateLimiter', () => {
  test('allows first request', async () => {
    const limiter = createInMemoryRateLimiter();
    const result = await limiter.check('key1', 1000, 5);
    expect(result.allowed).toBeTrue();
    expect(result.remaining).toBe(4);
  });

  test('decrements remaining count', async () => {
    const limiter = createInMemoryRateLimiter();
    const r1 = await limiter.check('key1', 10000, 3);
    const r2 = await limiter.check('key1', 10000, 3);
    const r3 = await limiter.check('key1', 10000, 3);
    expect(r1.remaining).toBe(2);
    expect(r2.remaining).toBe(1);
    expect(r3.remaining).toBe(0);
  });

  test('rejects when max reached', async () => {
    const limiter = createInMemoryRateLimiter();
    await limiter.check('key1', 10000, 2);
    await limiter.check('key1', 10000, 2);
    const r3 = await limiter.check('key1', 10000, 2);
    expect(r3.allowed).toBeFalse();
    expect(r3.remaining).toBe(0);
  });

  test('independent keys do not interfere', async () => {
    const limiter = createInMemoryRateLimiter();
    await limiter.check('key-a', 10000, 1);
    const r2 = await limiter.check('key-b', 10000, 1);
    expect(r2.allowed).toBeTrue();
  });

  test('resetAt is in the future', async () => {
    const limiter = createInMemoryRateLimiter();
    const now = Date.now();
    const result = await limiter.check('key1', 5000, 5);
    expect(result.resetAt).toBeGreaterThanOrEqual(now);
    expect(result.resetAt).toBeLessThanOrEqual(now + 5000 + 50);
  });

  test('provides resetAt on rejection', async () => {
    const limiter = createInMemoryRateLimiter();
    await limiter.check('key1', 10000, 1);
    const rejected = await limiter.check('key1', 10000, 1);
    expect(rejected.allowed).toBeFalse();
    expect(rejected.resetAt).toBeGreaterThan(0);
  });
});

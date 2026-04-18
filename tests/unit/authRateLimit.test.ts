import {
  type AuthRateLimitService,
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import { beforeEach, describe, expect, test } from 'bun:test';

const opts = { windowMs: 60_000, max: 3 };
let svc: AuthRateLimitService;

beforeEach(() => {
  svc = createAuthRateLimitService(createMemoryAuthRateLimitRepository());
});

describe('trackAttempt', () => {
  test('returns false when under the limit', async () => {
    const key = 'test:under';
    expect(await svc.trackAttempt(key, opts)).toBe(false);
    expect(await svc.trackAttempt(key, opts)).toBe(false);
  });

  test('returns true when exceeding the limit', async () => {
    const key = 'test:atmax';
    await svc.trackAttempt(key, opts); // count=1
    await svc.trackAttempt(key, opts); // count=2
    expect(await svc.trackAttempt(key, opts)).toBe(true); // count=3 reaches max=3
  });

  test('stays limited after exceeding the limit', async () => {
    const key = 'test:over';
    for (let i = 0; i < 5; i++) await svc.trackAttempt(key, opts);
    expect(await svc.isLimited(key, opts)).toBe(true);
  });
});

describe('isLimited', () => {
  test('returns false for unknown key', async () => {
    expect(await svc.isLimited('nonexistent', opts)).toBe(false);
  });

  test('returns false when under the limit', async () => {
    const key = 'test:check';
    await svc.trackAttempt(key, opts);
    expect(await svc.isLimited(key, opts)).toBe(false);
  });

  test('returns true when at the limit', async () => {
    const key = 'test:limited';
    for (let i = 0; i < 3; i++) await svc.trackAttempt(key, opts);
    expect(await svc.isLimited(key, opts)).toBe(true);
  });
});

describe('bustAuthLimit', () => {
  test('resets the counter so the key is no longer limited', async () => {
    const key = 'test:bust';
    for (let i = 0; i < 3; i++) await svc.trackAttempt(key, opts);
    expect(await svc.isLimited(key, opts)).toBe(true);
    await svc.bustAuthLimit(key);
    expect(await svc.isLimited(key, opts)).toBe(false);
  });

  test('is safe to call on a non-existent key', async () => {
    await svc.bustAuthLimit('test:missing');
    expect(await svc.isLimited('test:missing', opts)).toBe(false);
  });
});

describe('window expiry', () => {
  const shortOpts = { windowMs: 1000, max: 2 };

  test('counter resets after window expires', async () => {
    const key = 'test:expiry';
    await svc.trackAttempt(key, shortOpts);
    await svc.trackAttempt(key, shortOpts);
    expect(await svc.isLimited(key, shortOpts)).toBe(true);
    await Bun.sleep(1100);
    // After window, counter should be reset
    expect(await svc.isLimited(key, shortOpts)).toBe(false);
    expect(await svc.trackAttempt(key, shortOpts)).toBe(false); // fresh counter
  });

  test('isLimited does not increment the counter', async () => {
    const key = 'test:readonly';
    await svc.trackAttempt(key, opts); // count=1
    await svc.trackAttempt(key, opts); // count=2
    // 2 attempts, limit is 3 — not limited yet
    expect(await svc.isLimited(key, opts)).toBe(false);
    expect(await svc.isLimited(key, opts)).toBe(false);
    expect(await svc.isLimited(key, opts)).toBe(false);
    // isLimited is read-only: count is still 2
    expect(await svc.trackAttempt(key, opts)).toBe(true); // count=3 reaches max=3
    expect(await svc.trackAttempt(key, opts)).toBe(true); // count=4 remains limited
  });
});

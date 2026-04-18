import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createDefaultFingerprintBuilder } from '../src/defaults/defaultFingerprint';
import { createMemoryCacheAdapter } from '../src/defaults/memoryCacheAdapter';
import { createMemoryRateLimitAdapter } from '../src/defaults/memoryRateLimit';
import { isPublicPath } from '../src/publicPath';

let nowSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
});

describe('slingshot-core defaults', () => {
  test('isPublicPath matches exact paths and wildcard prefixes only', () => {
    const publicPaths = new Set(['/.well-known/*', '/public/ping']);

    expect(isPublicPath('/.well-known/apple-app-site-association', publicPaths)).toBe(true);
    expect(isPublicPath('/public/ping', publicPaths)).toBe(true);
    expect(isPublicPath('/public/ping/deeper', publicPaths)).toBe(false);
    expect(isPublicPath('/private/ping', publicPaths)).toBe(false);
    expect(isPublicPath('/anything', null)).toBe(false);
  });

  test('createMemoryCacheAdapter respects ttl, delete, and glob deletion', async () => {
    let now = 1_000;
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);

    const cache = createMemoryCacheAdapter();

    await cache.set('session:1', 'alpha', 10);
    await cache.set('rate.limit.1', 'keep');
    await cache.set('rateXlimitY1', 'also-keep');

    await expect(cache.get('session:1')).resolves.toBe('alpha');
    expect(cache.isReady()).toBe(true);

    await cache.delPattern('rate.limit.*');
    await expect(cache.get('rate.limit.1')).resolves.toBeNull();
    await expect(cache.get('rateXlimitY1')).resolves.toBe('also-keep');

    await cache.del('rateXlimitY1');
    await expect(cache.get('rateXlimitY1')).resolves.toBeNull();

    now += 10_001;
    await expect(cache.get('session:1')).resolves.toBeNull();
  });

  test('createMemoryRateLimitAdapter enforces max attempts and resets after the window', async () => {
    let now = 5_000;
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);

    const adapter = createMemoryRateLimitAdapter();

    await expect(adapter.trackAttempt('login:user-1', { windowMs: 1000, max: 2 })).resolves.toBe(
      false,
    );
    await expect(adapter.trackAttempt('login:user-1', { windowMs: 1000, max: 2 })).resolves.toBe(
      false,
    );
    await expect(adapter.trackAttempt('login:user-1', { windowMs: 1000, max: 2 })).resolves.toBe(
      true,
    );

    now += 1_001;
    await expect(adapter.trackAttempt('login:user-1', { windowMs: 1000, max: 2 })).resolves.toBe(
      false,
    );
  });

  test('createDefaultFingerprintBuilder is deterministic for the same headers and changes when inputs change', async () => {
    const builder = createDefaultFingerprintBuilder();
    const baseHeaders = {
      'user-agent': 'slingshot-tests',
      'accept-language': 'en-US',
      'accept-encoding': 'gzip',
    };

    const one = await builder.buildFingerprint(
      new Request('http://example.com', { headers: baseHeaders }),
    );
    const two = await builder.buildFingerprint(
      new Request('http://example.com', { headers: baseHeaders }),
    );
    const changed = await builder.buildFingerprint(
      new Request('http://example.com', {
        headers: { ...baseHeaders, 'accept-language': 'fr-CA' },
      }),
    );

    expect(one).toHaveLength(12);
    expect(one).toBe(two);
    expect(changed).not.toBe(one);
  });
});

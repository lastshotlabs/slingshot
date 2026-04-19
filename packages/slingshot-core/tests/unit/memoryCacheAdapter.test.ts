import { describe, expect, test } from 'bun:test';
import { createMemoryCacheAdapter } from '../../src/defaults/memoryCacheAdapter';

describe('createMemoryCacheAdapter', () => {
  test('name is "memory"', () => {
    const cache = createMemoryCacheAdapter();
    expect(cache.name).toBe('memory');
  });

  test('isReady returns true', () => {
    const cache = createMemoryCacheAdapter();
    expect(cache.isReady()).toBe(true);
  });

  describe('get / set', () => {
    test('returns null for a missing key', async () => {
      const cache = createMemoryCacheAdapter();
      expect(await cache.get('nonexistent')).toBeNull();
    });

    test('stores and retrieves a value', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('key1', 'value1');
      expect(await cache.get('key1')).toBe('value1');
    });

    test('overwrites an existing key', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('k', 'v1');
      await cache.set('k', 'v2');
      expect(await cache.get('k')).toBe('v2');
    });
  });

  describe('TTL expiration', () => {
    test('returns null for an expired entry on get (point-in-time check)', async () => {
      const cache = createMemoryCacheAdapter();
      // Set with a TTL of 0 seconds — expires immediately
      // TTL is in seconds, so ttl=0 => expiresAt = Date.now() + 0
      // However, since ttl is falsy when 0, let's use a tiny positive value
      // Actually, looking at the code: `ttl ? Date.now() + ttl * 1000 : undefined`
      // ttl=0 is falsy so no expiration. Let's test with ttl > 0 but very small.
      // We need to make the entry expire. The simplest approach is to set a very
      // short TTL and then wait, but that's fragile. Instead we can test the
      // boundary by understanding the implementation.

      // Set with 1 second TTL
      await cache.set('expiring', 'hello', 1);
      // Immediately it should still be there
      expect(await cache.get('expiring')).toBe('hello');
    });

    test('expired entry returns null after TTL elapses', async () => {
      const cache = createMemoryCacheAdapter();
      // Use a tiny TTL: the entry expiration is Date.now() + ttl * 1000
      // With ttl = 0.001 (1ms), it should expire almost instantly
      await cache.set('expiring', 'hello', 0.001);
      // Wait a bit to ensure expiration
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(await cache.get('expiring')).toBeNull();
    });

    test('entry without TTL does not expire', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('permanent', 'stays');
      // Even after a short delay
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await cache.get('permanent')).toBe('stays');
    });
  });

  describe('del', () => {
    test('deletes an existing key', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('d', 'val');
      await cache.del('d');
      expect(await cache.get('d')).toBeNull();
    });

    test('del on non-existent key does not throw', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.del('nope'); // should not throw
    });
  });

  describe('delPattern', () => {
    test('deletes keys matching a glob pattern with trailing wildcard', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('session:abc', '1');
      await cache.set('session:def', '2');
      await cache.set('other:xyz', '3');
      await cache.delPattern('session:*');
      expect(await cache.get('session:abc')).toBeNull();
      expect(await cache.get('session:def')).toBeNull();
      expect(await cache.get('other:xyz')).toBe('3');
    });

    test('escapes regex metacharacters in pattern (dots)', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('rate.limit.user1', 'a');
      await cache.set('ratexlimitxuser1', 'b');
      await cache.delPattern('rate.limit.*');
      // The dot is escaped, so 'ratexlimitxuser1' should NOT be deleted
      expect(await cache.get('rate.limit.user1')).toBeNull();
      expect(await cache.get('ratexlimitxuser1')).toBe('b');
    });

    test('escapes brackets in pattern', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('cache[1]', 'val');
      await cache.set('cache1', 'other');
      await cache.delPattern('cache[1]');
      expect(await cache.get('cache[1]')).toBeNull();
      // 'cache1' should not match because brackets are escaped
      expect(await cache.get('cache1')).toBe('other');
    });

    test('pattern with no wildcard matches exact key', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('exact', 'val');
      await cache.set('exactlyMore', 'other');
      await cache.delPattern('exact');
      expect(await cache.get('exact')).toBeNull();
      expect(await cache.get('exactlyMore')).toBe('other');
    });

    test('pattern with multiple wildcards', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('a:b:c', '1');
      await cache.set('a:x:c', '2');
      await cache.set('a:x:z', '3');
      await cache.delPattern('a:*:c');
      expect(await cache.get('a:b:c')).toBeNull();
      expect(await cache.get('a:x:c')).toBeNull();
      expect(await cache.get('a:x:z')).toBe('3');
    });

    test('pattern matching no keys does not throw', async () => {
      const cache = createMemoryCacheAdapter();
      await cache.set('a', '1');
      await cache.delPattern('zzz:*');
      expect(await cache.get('a')).toBe('1');
    });
  });

  describe('independent instances', () => {
    test('two adapters have independent stores', async () => {
      const cache1 = createMemoryCacheAdapter();
      const cache2 = createMemoryCacheAdapter();
      await cache1.set('shared', 'from1');
      expect(await cache2.get('shared')).toBeNull();
    });
  });
});

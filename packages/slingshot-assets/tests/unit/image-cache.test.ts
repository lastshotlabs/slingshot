import { describe, expect, test } from 'bun:test';
import { createMemoryImageCache } from '../../src/image/cache';
import type { ImageCacheEntry } from '../../src/image/types';

function makeEntry(generatedAt: number): ImageCacheEntry {
  return {
    buffer: new ArrayBuffer(1),
    contentType: 'image/webp',
    generatedAt,
  };
}

describe('createMemoryImageCache', () => {
  test('LRU eviction triggers when maxEntries is exceeded', async () => {
    const cache = createMemoryImageCache({ maxEntries: 2, ttlMs: 0 });

    await cache.set('a', makeEntry(0));
    await cache.set('b', makeEntry(0));
    await cache.set('c', makeEntry(0)); // evicts 'a'

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();

    const stats = cache.getHealth?.();
    expect(stats?.size).toBe(2);
    expect(stats?.evictionCount).toBe(1);
    expect(stats?.ttlEvictionCount).toBe(0);
  });

  test('TTL eviction triggers on access when entry is expired', async () => {
    let nowMs = 1_000;
    const cache = createMemoryImageCache({
      maxEntries: 100,
      ttlMs: 5_000,
      now: () => nowMs,
    });

    await cache.set('fresh', makeEntry(nowMs));

    // Within TTL
    nowMs += 1_000;
    expect(await cache.get('fresh')).not.toBeNull();

    // Past TTL — eviction on access, returns null
    nowMs += 10_000;
    expect(await cache.get('fresh')).toBeNull();

    const stats = cache.getHealth?.();
    expect(stats?.size).toBe(0);
    expect(stats?.evictionCount).toBe(0);
    expect(stats?.ttlEvictionCount).toBe(1);
  });

  test('ttlMs=0 disables TTL eviction', async () => {
    let nowMs = 1_000;
    const cache = createMemoryImageCache({
      maxEntries: 100,
      ttlMs: 0,
      now: () => nowMs,
    });

    await cache.set('k', makeEntry(nowMs));
    nowMs += 365 * 24 * 60 * 60_000; // a year later

    expect(await cache.get('k')).not.toBeNull();
    expect(cache.getHealth?.().ttlEvictionCount).toBe(0);
  });

  test('LRU recency is refreshed on get and survives TTL eviction of unrelated keys', async () => {
    let nowMs = 1_000;
    const cache = createMemoryImageCache({
      maxEntries: 2,
      ttlMs: 10_000,
      now: () => nowMs,
    });

    await cache.set('a', makeEntry(nowMs));
    await cache.set('b', makeEntry(nowMs));

    // Touch 'a' so it becomes most-recently-used
    nowMs += 1_000;
    await cache.get('a');

    // Insert 'c' — should evict 'b' (LRU), not 'a'
    await cache.set('c', makeEntry(nowMs));

    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).not.toBeNull();

    const stats = cache.getHealth?.();
    expect(stats?.evictionCount).toBe(1);
    expect(stats?.ttlEvictionCount).toBe(0);
  });
});

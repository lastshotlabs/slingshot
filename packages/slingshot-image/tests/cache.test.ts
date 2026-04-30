// packages/slingshot-image/tests/cache.test.ts
import { describe, expect, it } from 'bun:test';
import { buildCacheKey, createMemoryImageCache } from '../src/cache';
import type { ImageCacheEntry } from '../src/types';

/** Helper: create a minimal cache entry. */
function makeEntry(label?: string): ImageCacheEntry {
  return {
    buffer: new TextEncoder().encode(label ?? 'data').buffer as ArrayBuffer,
    contentType: 'image/jpeg',
    generatedAt: Date.now(),
  };
}

// ── LRU eviction behavior ─────────────────────────────────────────

describe('LRU cache eviction', () => {
  it('evicts the oldest entry when capacity is reached', async () => {
    const cache = createMemoryImageCache({ maxEntries: 3 });
    await cache.set('a', makeEntry('a'));
    await cache.set('b', makeEntry('b'));
    await cache.set('c', makeEntry('c'));

    // 'a' is oldest, adding 'd' should evict it
    await cache.set('d', makeEntry('d'));
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    expect(await cache.get('d')).not.toBeNull();
  });

  it('reading an entry bumps it to most-recently-used position', async () => {
    const cache = createMemoryImageCache({ maxEntries: 3 });
    await cache.set('a', makeEntry('a'));
    await cache.set('b', makeEntry('b'));
    await cache.set('c', makeEntry('c'));

    // Access 'a' to bump it — now 'b' is oldest
    await cache.get('a');
    await cache.set('d', makeEntry('d'));

    expect(await cache.get('a')).not.toBeNull(); // bumped, should survive
    expect(await cache.get('b')).toBeNull(); // oldest after bump, evicted
    expect(await cache.get('c')).not.toBeNull();
    expect(await cache.get('d')).not.toBeNull();
  });

  it('evicts multiple times correctly as capacity is maintained', async () => {
    const cache = createMemoryImageCache({ maxEntries: 2 });
    await cache.set('a', makeEntry('a'));
    await cache.set('b', makeEntry('b'));

    // Evict 'a'
    await cache.set('c', makeEntry('c'));
    expect(await cache.get('a')).toBeNull();

    // Evict 'b'
    await cache.set('d', makeEntry('d'));
    expect(await cache.get('b')).toBeNull();

    // Only 'c' and 'd' remain
    expect(await cache.get('c')).not.toBeNull();
    expect(await cache.get('d')).not.toBeNull();
  });

  it('does not evict when updating an existing key at capacity', async () => {
    const cache = createMemoryImageCache({ maxEntries: 2 });
    await cache.set('a', makeEntry('a'));
    await cache.set('b', makeEntry('b'));

    // Update 'a' should NOT evict anything — the key already exists
    await cache.set('a', makeEntry('a-updated'));

    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('b')).not.toBeNull();
  });

  it('handles maxEntries of 1', async () => {
    const cache = createMemoryImageCache({ maxEntries: 1 });
    await cache.set('a', makeEntry('a'));
    await cache.set('b', makeEntry('b'));

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
  });

  it('uses default maxEntries when none provided', async () => {
    const cache = createMemoryImageCache();
    // Should not throw with many entries (default is 500)
    for (let i = 0; i < 10; i++) {
      await cache.set(`key-${i}`, makeEntry(`${i}`));
    }
    // All 10 should be present since 10 < 500
    for (let i = 0; i < 10; i++) {
      expect(await cache.get(`key-${i}`)).not.toBeNull();
    }
  });
});

// ── Concurrent cache access ───────────────────────────────────────

describe('Concurrent cache access', () => {
  it('handles multiple simultaneous reads for the same key', async () => {
    const cache = createMemoryImageCache();
    const entry = makeEntry('shared');
    await cache.set('shared-key', entry);

    // Fire multiple reads concurrently
    const results = await Promise.all([
      cache.get('shared-key'),
      cache.get('shared-key'),
      cache.get('shared-key'),
      cache.get('shared-key'),
      cache.get('shared-key'),
    ]);

    // All should return the same entry
    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe('image/jpeg');
    }
  });

  it('handles concurrent writes for the same key', async () => {
    const cache = createMemoryImageCache();
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`concurrent-${i}`));

    // Write 5 entries with the same key concurrently
    await Promise.all(entries.map((entry, i) => cache.set('same-key', entry)));

    // The key should exist — last write wins
    const result = await cache.get('same-key');
    expect(result).not.toBeNull();
  });

  it('handles concurrent reads and writes without corruption', async () => {
    const cache = createMemoryImageCache({ maxEntries: 10 });

    // Mix of reads and writes running concurrently
    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      operations.push(cache.set(`key-${i % 10}`, makeEntry(`${i}`)));
      operations.push(cache.get(`key-${i % 10}`));
    }

    // Should not throw
    await Promise.all(operations);

    // Cache should still function correctly
    await cache.set('final', makeEntry('final'));
    expect(await cache.get('final')).not.toBeNull();
  });
});

// ── Cache key collision resistance ────────────────────────────────

describe('Cache key collision resistance', () => {
  it('produces different keys for different URLs with same dimensions', () => {
    const k1 = buildCacheKey('/img-a.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img-b.jpg', 400, 300, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different widths', () => {
    const k1 = buildCacheKey('/img.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img.jpg', 800, 300, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different heights', () => {
    const k1 = buildCacheKey('/img.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img.jpg', 400, 600, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different formats', () => {
    const k1 = buildCacheKey('/img.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img.jpg', 400, 300, 'avif', 80);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different quality values', () => {
    const k1 = buildCacheKey('/img.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img.jpg', 400, 300, 'webp', 90);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for undefined vs zero height', () => {
    const k1 = buildCacheKey('/img.jpg', 400, undefined, 'webp', 80);
    const k2 = buildCacheKey('/img.jpg', 400, 0, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('handles URL-encoded characters without collision', () => {
    const k1 = buildCacheKey('/img%20a.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img a.jpg', 400, 300, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('handles URLs with colons without ambiguity', () => {
    // The key format uses colons as delimiters. URLs with colons should
    // still produce unique keys because the URL is the first segment.
    const k1 = buildCacheKey('https://cdn.example.com:8080/img.jpg', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('https://cdn.example.com', 8080, 300, 'webp', 80);
    expect(k1).not.toBe(k2);
  });

  it('handles very long URLs without truncation', () => {
    const longUrl = '/images/' + 'a'.repeat(2000) + '.jpg';
    const key = buildCacheKey(longUrl, 400, 300, 'webp', 80);
    expect(key).toContain(longUrl);
  });

  it('handles special characters in URLs', () => {
    const k1 = buildCacheKey('/img?v=1&size=large', 400, 300, 'webp', 80);
    const k2 = buildCacheKey('/img?v=2&size=large', 400, 300, 'webp', 80);
    expect(k1).not.toBe(k2);
  });
});

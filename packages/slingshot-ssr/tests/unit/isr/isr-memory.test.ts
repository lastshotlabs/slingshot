import { describe, expect, it } from 'bun:test';
import { createMemoryIsrCache } from '../../../src/isr/memory';
import type { IsrCacheEntry } from '../../../src/isr/types';

function makeEntry(overrides: Partial<IsrCacheEntry> = {}): IsrCacheEntry {
  const now = Date.now();
  return {
    html: '<html><body>cached</body></html>',
    headers: { 'content-type': 'text/html; charset=utf-8' },
    generatedAt: now,
    revalidateAfter: now + 60_000,
    tags: [],
    ...overrides,
  };
}

describe('createMemoryIsrCache — factory isolation', () => {
  it('creates independent instances with no shared state', async () => {
    const a = createMemoryIsrCache();
    const b = createMemoryIsrCache();

    await a.set('/posts', makeEntry({ html: '<html>A</html>', tags: [] }));

    const fromA = await a.get('/posts');
    const fromB = await b.get('/posts');

    expect(fromA).not.toBeNull();
    expect(fromB).toBeNull(); // B has no state from A
  });
});

describe('createMemoryIsrCache — get/set', () => {
  it('returns null for an unknown path', async () => {
    const cache = createMemoryIsrCache();
    expect(await cache.get('/unknown')).toBeNull();
  });

  it('stores and retrieves an entry', async () => {
    const cache = createMemoryIsrCache();
    const entry = makeEntry({ html: '<html>hello</html>', tags: ['posts'] });
    await cache.set('/posts', entry);
    const result = await cache.get('/posts');
    expect(result).toEqual(entry);
  });

  it('overwrites an existing entry', async () => {
    const cache = createMemoryIsrCache();
    const first = makeEntry({ html: '<html>first</html>', tags: [] });
    const second = makeEntry({ html: '<html>second</html>', tags: [] });
    await cache.set('/page', first);
    await cache.set('/page', second);
    const result = await cache.get('/page');
    expect(result?.html).toBe('<html>second</html>');
  });
});

describe('createMemoryIsrCache — invalidatePath', () => {
  it('removes a specific entry', async () => {
    const cache = createMemoryIsrCache();
    await cache.set('/posts', makeEntry());
    await cache.invalidatePath('/posts');
    expect(await cache.get('/posts')).toBeNull();
  });

  it('does not affect other entries', async () => {
    const cache = createMemoryIsrCache();
    await cache.set('/posts', makeEntry({ html: '<html>posts</html>' }));
    await cache.set('/home', makeEntry({ html: '<html>home</html>' }));
    await cache.invalidatePath('/posts');
    expect(await cache.get('/posts')).toBeNull();
    expect(await cache.get('/home')).not.toBeNull();
  });

  it('is a no-op for a path that does not exist', async () => {
    const cache = createMemoryIsrCache();
    // Should not throw
    await expect(cache.invalidatePath('/nonexistent')).resolves.toBeUndefined();
  });
});

describe('createMemoryIsrCache — invalidateTag', () => {
  it('removes all entries tagged with the given tag', async () => {
    const cache = createMemoryIsrCache();
    await cache.set('/posts', makeEntry({ tags: ['posts'] }));
    await cache.set('/posts/abc', makeEntry({ tags: ['posts', 'post:abc'] }));
    await cache.set('/home', makeEntry({ tags: ['home'] }));

    await cache.invalidateTag('posts');

    expect(await cache.get('/posts')).toBeNull();
    expect(await cache.get('/posts/abc')).toBeNull();
    expect(await cache.get('/home')).not.toBeNull(); // unaffected
  });

  it('is a no-op for an unknown tag', async () => {
    const cache = createMemoryIsrCache();
    await expect(cache.invalidateTag('unknown-tag')).resolves.toBeUndefined();
  });

  it('handles an entry with multiple tags correctly', async () => {
    const cache = createMemoryIsrCache();
    await cache.set('/post/1', makeEntry({ tags: ['posts', 'post:1', 'featured'] }));

    // Invalidating by any of its tags should remove the entry
    await cache.invalidateTag('featured');
    expect(await cache.get('/post/1')).toBeNull();
  });

  it('removes only entries sharing the invalidated tag', async () => {
    const cache = createMemoryIsrCache();
    await cache.set('/p/1', makeEntry({ tags: ['post:1'] }));
    await cache.set('/p/2', makeEntry({ tags: ['post:2'] }));

    await cache.invalidateTag('post:1');

    expect(await cache.get('/p/1')).toBeNull();
    expect(await cache.get('/p/2')).not.toBeNull();
  });
});

describe('createMemoryIsrCache — maxEntries (LRU eviction)', () => {
  it('evicts the oldest entry when at capacity', async () => {
    const cache = createMemoryIsrCache({ maxEntries: 3 });

    await cache.set('/a', makeEntry({ tags: [] }));
    await cache.set('/b', makeEntry({ tags: [] }));
    await cache.set('/c', makeEntry({ tags: [] }));

    // All three are present
    expect(await cache.get('/a')).not.toBeNull();
    expect(await cache.get('/b')).not.toBeNull();
    expect(await cache.get('/c')).not.toBeNull();

    // Adding a 4th entry — /a (oldest by insertion order) should be evicted
    await cache.set('/d', makeEntry({ tags: [] }));

    expect(await cache.get('/a')).toBeNull();
    expect(await cache.get('/b')).not.toBeNull();
    expect(await cache.get('/c')).not.toBeNull();
    expect(await cache.get('/d')).not.toBeNull();
  });

  it('does not evict when updating an existing key at capacity', async () => {
    const cache = createMemoryIsrCache({ maxEntries: 2 });

    await cache.set('/a', makeEntry({ html: '<html>a1</html>', tags: [] }));
    await cache.set('/b', makeEntry({ html: '<html>b1</html>', tags: [] }));

    // Update /a — should not evict anything (key already exists)
    await cache.set('/a', makeEntry({ html: '<html>a2</html>', tags: [] }));

    expect((await cache.get('/a'))?.html).toBe('<html>a2</html>');
    expect(await cache.get('/b')).not.toBeNull();
  });

  it('evicts entries sequentially as new entries are added', async () => {
    const cache = createMemoryIsrCache({ maxEntries: 2 });

    await cache.set('/1', makeEntry({ tags: [] }));
    await cache.set('/2', makeEntry({ tags: [] }));
    await cache.set('/3', makeEntry({ tags: [] })); // evicts /1
    await cache.set('/4', makeEntry({ tags: [] })); // evicts /2

    expect(await cache.get('/1')).toBeNull();
    expect(await cache.get('/2')).toBeNull();
    expect(await cache.get('/3')).not.toBeNull();
    expect(await cache.get('/4')).not.toBeNull();
  });
});

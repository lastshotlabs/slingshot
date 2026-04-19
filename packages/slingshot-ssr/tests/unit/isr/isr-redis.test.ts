import { describe, expect, it } from 'bun:test';
import { createRedisIsrCache } from '../../../src/isr/redis';
import type { IsrCacheEntry, RedisLike } from '../../../src/isr/types';

// ── Mock Redis client ──────────────────────────────────────────────────────────

function createMockRedis(): RedisLike & {
  _store: Map<string, string>;
  _sets: Map<string, Set<string>>;
} {
  const _store = new Map<string, string>();
  const _sets = new Map<string, Set<string>>();

  return {
    _store,
    _sets,

    async set(key: string, value: string): Promise<unknown> {
      _store.set(key, value);
      return 'OK';
    },

    async get(key: string): Promise<string | null> {
      return _store.get(key) ?? null;
    },

    async del(...keys: string[]): Promise<unknown> {
      for (const k of keys) {
        _store.delete(k);
        _sets.delete(k);
      }
      return keys.length;
    },

    async sadd(key: string, ...members: string[]): Promise<unknown> {
      if (!_sets.has(key)) _sets.set(key, new Set());
      for (const m of members) _sets.get(key)!.add(m);
      return members.length;
    },

    async smembers(key: string): Promise<string[]> {
      return Array.from(_sets.get(key) ?? []);
    },

    async srem(key: string, ...members: string[]): Promise<unknown> {
      const s = _sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed++;
      }
      return removed;
    },
  };
}

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('createRedisIsrCache — get', () => {
  it('returns null for a path not in Redis', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    expect(await cache.get('/posts')).toBeNull();
  });

  it('deserializes and returns a stored entry', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    const entry = makeEntry({ html: '<html>redis</html>', tags: ['posts'] });
    await cache.set('/posts', entry);
    const result = await cache.get('/posts');
    expect(result).toEqual(entry);
  });

  it('returns null when stored value is corrupt JSON', async () => {
    const redis = createMockRedis();
    redis._store.set('isr:page:/bad', 'not-valid-json{{{');
    const cache = createRedisIsrCache(redis);
    expect(await cache.get('/bad')).toBeNull();
  });
});

describe('createRedisIsrCache — set', () => {
  it('stores the entry at isr:page:{path} without a TTL to preserve SWR semantics', async () => {
    const redis = createMockRedis();
    const setCalls: Array<[string, string, 'EX' | undefined, number | undefined]> = [];
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, mode?, ttl?) => {
      setCalls.push([key, value, mode as 'EX' | undefined, ttl as number | undefined]);
      return mode === undefined
        ? originalSet(key, value)
        : originalSet(key, value, 'EX', ttl as number);
    };

    const cache = createRedisIsrCache(redis);
    const now = Date.now();
    const entry = makeEntry({
      generatedAt: now,
      revalidateAfter: now + 30_000, // 30 seconds TTL
      tags: [],
    });

    await cache.set('/page', entry);

    expect(setCalls).toHaveLength(1);
    const [key, , mode, ttl] = setCalls[0];
    expect(key).toBe('isr:page:/page');
    expect(mode).toBeUndefined();
    expect(ttl).toBeUndefined();
  });

  it('updates tag index (sadd) for each tag in the entry', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    const entry = makeEntry({ tags: ['posts', 'post:123'] });

    await cache.set('/posts/123', entry);

    const postsMembers = await redis.smembers('isr:tag:posts');
    const postMembers = await redis.smembers('isr:tag:post:123');

    expect(postsMembers).toContain('/posts/123');
    expect(postMembers).toContain('/posts/123');
  });

  it('does not call sadd when tags array is empty', async () => {
    const redis = createMockRedis();
    let saddCalls = 0;
    const originalSadd = redis.sadd.bind(redis);
    redis.sadd = async (key, ...members) => {
      saddCalls++;
      return originalSadd(key, ...members);
    };

    const cache = createRedisIsrCache(redis);
    await cache.set('/no-tags', makeEntry({ tags: [] }));

    expect(saddCalls).toBe(0);
  });

  it('still stores stale entries without EX when revalidateAfter is already in the past', async () => {
    const redis = createMockRedis();
    const setCalls: Array<[string, string, 'EX' | undefined, number | undefined]> = [];
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, mode?, ttl?) => {
      setCalls.push([key, value, mode as 'EX' | undefined, ttl as number | undefined]);
      return mode === undefined
        ? originalSet(key, value)
        : originalSet(key, value, 'EX', ttl as number);
    };

    const cache = createRedisIsrCache(redis);
    const past = Date.now() - 10_000; // already expired
    const entry = makeEntry({ revalidateAfter: past });

    await cache.set('/expired', entry);

    const [, , mode, ttl] = setCalls[0];
    expect(mode).toBeUndefined();
    expect(ttl).toBeUndefined();
  });
});

describe('createRedisIsrCache — invalidatePath', () => {
  it('deletes the page key from Redis', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    await cache.set('/posts', makeEntry());
    await cache.invalidatePath('/posts');
    expect(await redis.get('isr:page:/posts')).toBeNull();
  });

  it('is a no-op for an unknown path', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    await expect(cache.invalidatePath('/nonexistent')).resolves.toBeUndefined();
  });
});

describe('createRedisIsrCache — invalidateTag', () => {
  it('deletes all page keys for the tag and removes the tag key', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);

    await cache.set('/posts', makeEntry({ tags: ['posts'] }));
    await cache.set('/posts/1', makeEntry({ tags: ['posts', 'post:1'] }));
    await cache.set('/home', makeEntry({ tags: ['home'] }));

    await cache.invalidateTag('posts');

    expect(await redis.get('isr:page:/posts')).toBeNull();
    expect(await redis.get('isr:page:/posts/1')).toBeNull();
    expect(await redis.get('isr:page:/home')).not.toBeNull(); // unaffected
    expect(await redis.smembers('isr:tag:posts')).toHaveLength(0); // tag set removed
  });

  it('is a no-op when the tag has no members', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);
    await expect(cache.invalidateTag('nonexistent-tag')).resolves.toBeUndefined();
  });

  it('preserves tag sets for other tags after invalidation', async () => {
    const redis = createMockRedis();
    const cache = createRedisIsrCache(redis);

    await cache.set('/post/1', makeEntry({ tags: ['posts', 'post:1'] }));
    await cache.set('/post/2', makeEntry({ tags: ['posts', 'post:2'] }));

    // Invalidate by post:1 — should not affect post:2 tag set
    await cache.invalidateTag('post:1');

    expect(await redis.get('isr:page:/post/1')).toBeNull();
    expect(await redis.get('isr:page:/post/2')).not.toBeNull();
    const post2Tag = await redis.smembers('isr:tag:post:2');
    expect(post2Tag).toContain('/post/2');
  });
});

describe('createRedisIsrCache — factory isolation', () => {
  it('two instances share the same Redis client but operate independently', async () => {
    const redis = createMockRedis();
    const a = createRedisIsrCache(redis);
    const b = createRedisIsrCache(redis);

    // Both write to the same underlying Redis — they share state through Redis itself
    await a.set('/page', makeEntry({ html: '<html>from-a</html>', tags: [] }));
    const fromB = await b.get('/page');

    // Shared Redis means both can read what either writes (this is the correct
    // semantics for Redis-backed ISR: all instances share the cache)
    expect(fromB?.html).toBe('<html>from-a</html>');
  });
});

// packages/runtime-edge/tests/unit/kv-isr.test.ts
// Note: Cloudflare KV operations have no client-side timeout.
// Edge runtimes enforce a 30s wall-clock limit; KV calls that stall
// will exhaust the request lifetime. Applications that require timeout
// guarantees should wrap cache adapter calls in Promise.race() with a timeout.
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IsrCacheEntry } from '@lastshotlabs/slingshot-ssr';
import { type KvNamespace, createKvIsrCache } from '../../src/kv-isr';

// ---------------------------------------------------------------------------
// In-memory KV mock
// ---------------------------------------------------------------------------

function createMockKv(): KvNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
      const prefix = opts?.prefix ?? '';
      const keys: Array<{ name: string }> = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) keys.push({ name: key });
      }
      return { keys };
    },
  };
}

function makeEntry(
  path: string,
  tags: string[] = [],
  revalidateAfter = Date.now() + 60_000,
): IsrCacheEntry {
  return {
    html: `<html><body>${path}</body></html>`,
    headers: { 'content-type': 'text/html' },
    generatedAt: Date.now(),
    revalidateAfter,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createKvIsrCache()', () => {
  let kv: ReturnType<typeof createMockKv>;
  let cache: ReturnType<typeof createKvIsrCache>;

  beforeEach(() => {
    kv = createMockKv();
    cache = createKvIsrCache(kv);
  });

  describe('get()', () => {
    it('returns null on a cache miss', async () => {
      expect(await cache.get('/posts')).toBeNull();
    });

    it('returns the stored entry on a hit', async () => {
      const entry = makeEntry('/posts', ['posts']);
      await cache.set('/posts', entry);
      const result = await cache.get('/posts');
      expect(result).not.toBeNull();
      expect(result?.html).toBe(entry.html);
    });

    it('returns null for corrupt JSON', async () => {
      kv._store.set('isr:page:/corrupt', 'not-valid-json{{{');
      expect(await cache.get('/corrupt')).toBeNull();
    });
  });

  describe('set()', () => {
    it('stores the entry under the correct key', async () => {
      const entry = makeEntry('/about', ['static']);
      await cache.set('/about', entry);
      expect(kv._store.has('isr:page:/about')).toBe(true);
    });

    it('updates the tag index for each tag', async () => {
      const entry = makeEntry('/posts/1', ['posts', 'post:1']);
      await cache.set('/posts/1', entry);

      const postsIndex = JSON.parse(kv._store.get('isr:tag:posts') ?? '[]') as string[];
      const postIndex = JSON.parse(kv._store.get('isr:tag:post:1') ?? '[]') as string[];

      expect(postsIndex).toContain('/posts/1');
      expect(postIndex).toContain('/posts/1');
    });

    it('appends to an existing tag index without duplicates', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.set('/posts/2', makeEntry('/posts/2', ['posts']));
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts'])); // re-set

      const postsIndex = JSON.parse(kv._store.get('isr:tag:posts') ?? '[]') as string[];
      // /posts/1 should appear exactly once
      expect(postsIndex.filter(p => p === '/posts/1')).toHaveLength(1);
      expect(postsIndex).toContain('/posts/2');
    });

    it('stores no tag index when entry has no tags', async () => {
      await cache.set('/no-tags', makeEntry('/no-tags', []));
      for (const key of kv._store.keys()) {
        expect(key.startsWith('isr:tag:')).toBe(false);
      }
    });

    it('repairs a corrupt tag index when adding a newly tagged path', async () => {
      kv._store.set('isr:tag:posts', 'not-valid-json');

      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));

      expect(JSON.parse(kv._store.get('isr:tag:posts') ?? '[]')).toEqual(['/posts/1']);
    });

    it('removes dropped tags and keeps retained tags when updating an entry', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts', 'featured']));

      await cache.set('/posts/1', makeEntry('/posts/1', ['featured', 'fresh']));

      expect(kv._store.has('isr:tag:posts')).toBe(false);
      expect(JSON.parse(kv._store.get('isr:tag:featured') ?? '[]')).toEqual(['/posts/1']);
      expect(JSON.parse(kv._store.get('isr:tag:fresh') ?? '[]')).toEqual(['/posts/1']);
    });

    it('rewrites a tag index when removing one path but retaining others', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.set('/posts/2', makeEntry('/posts/2', ['posts']));

      await cache.set('/posts/1', makeEntry('/posts/1', ['fresh']));

      expect(JSON.parse(kv._store.get('isr:tag:posts') ?? '[]')).toEqual(['/posts/2']);
      expect(JSON.parse(kv._store.get('isr:tag:fresh') ?? '[]')).toEqual(['/posts/1']);
    });

    it('ignores corrupt old page metadata when diffing tags for an update', async () => {
      kv._store.set('isr:page:/broken', 'not-valid-json');

      await cache.set('/broken', makeEntry('/broken', ['repaired']));

      expect(JSON.parse(kv._store.get('isr:tag:repaired') ?? '[]')).toEqual(['/broken']);
    });

    it('ignores corrupt tag indexes when removing a dropped tag', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts', 'featured']));
      kv._store.set('isr:tag:posts', 'not-valid-json');

      await expect(
        cache.set('/posts/1', makeEntry('/posts/1', ['featured'])),
      ).resolves.toBeUndefined();

      expect(kv._store.get('isr:tag:posts')).toBe('not-valid-json');
      expect(JSON.parse(kv._store.get('isr:tag:featured') ?? '[]')).toEqual(['/posts/1']);
    });

    it('does not poison future tag additions after a failed tag-index write', async () => {
      let failNextPostsPut = true;
      const originalPut = kv.put.bind(kv);
      kv.put = async (key: string, value: string) => {
        if (key === 'isr:tag:posts' && failNextPostsPut) {
          failNextPostsPut = false;
          throw new Error('simulated put failure');
        }
        await originalPut(key, value);
      };

      await expect(cache.set('/posts/1', makeEntry('/posts/1', ['posts']))).rejects.toThrow(
        'simulated put failure',
      );

      await expect(
        cache.set('/posts/2', makeEntry('/posts/2', ['posts'])),
      ).resolves.toBeUndefined();
      expect(JSON.parse(kv._store.get('isr:tag:posts') ?? '[]')).toEqual(['/posts/2']);
    });

    it('does not poison future tag updates after a failed removal step', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));

      let failNextPostsGet = true;
      const originalGet = kv.get.bind(kv);
      kv.get = async (key: string) => {
        if (key === 'isr:tag:posts' && failNextPostsGet) {
          failNextPostsGet = false;
          throw new Error('simulated get failure');
        }
        return await originalGet(key, { type: 'text' });
      };

      await expect(cache.set('/posts/1', makeEntry('/posts/1', []))).rejects.toThrow(
        'simulated get failure',
      );

      await expect(
        cache.set('/posts/2', makeEntry('/posts/2', ['posts'])),
      ).resolves.toBeUndefined();
      expect(JSON.parse(kv._store.get('isr:tag:posts') ?? '[]')).toEqual(['/posts/1', '/posts/2']);
    });
  });

  describe('updateTagIndex error logging', () => {
    it('updateTagIndex logs errors and clears chain on KV failure', async () => {
      let callCount = 0;
      const store = new Map<string, string>();
      const failingKv = {
        async get(key: string) { return store.get(key) ?? null; },
        async put(key: string, value: string) {
          callCount++;
          // First put is the page entry write — let it succeed.
          // Second put is the tag index write — fail it.
          if (callCount === 2) throw new Error('kv-quota-exceeded');
          store.set(key, value);
        },
        async delete() {},
        async list() { return { keys: [] }; },
      };

      const consoleSpy = mock(() => {});
      const originalError = console.error;
      console.error = consoleSpy;

      const cache = createKvIsrCache(failingKv as any);

      try {
        // cache.set rejects because updateTagIndex returns the raw (uncaught) promise
        await expect(
          cache.set('/page', { html: '<p>hi</p>', headers: {}, tags: ['t1'], revalidateAfter: 0, generatedAt: Date.now() }),
        ).rejects.toThrow('kv-quota-exceeded');

        // Yield to the microtask queue so the .catch() log handler on tagLocks fires
        await Promise.resolve();

        // Error was logged by the catch handler on the tag lock chain
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[runtime-edge]'),
          expect.any(Error),
        );

        // The chain is cleared — subsequent calls for the same tag should not be blocked
        await expect(
          cache.set('/page2', { html: '<p>ok</p>', headers: {}, tags: ['t1'], revalidateAfter: 0, generatedAt: Date.now() }),
        ).resolves.toBeUndefined();
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('invalidatePath()', () => {
    it('removes the page entry', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.invalidatePath('/posts/1');
      expect(kv._store.has('isr:page:/posts/1')).toBe(false);
    });

    it('is a no-op when the path does not exist', async () => {
      await expect(cache.invalidatePath('/nonexistent')).resolves.toBeUndefined();
    });

    it('does not remove the tag index entry (lazy cleanup)', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.invalidatePath('/posts/1');
      // Tag index is NOT cleaned up by invalidatePath — by design (lazy cleanup)
      expect(kv._store.has('isr:tag:posts')).toBe(true);
    });
  });

  describe('invalidateTag()', () => {
    it('removes all page entries for the given tag', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.set('/posts/2', makeEntry('/posts/2', ['posts']));
      await cache.invalidateTag('posts');
      expect(kv._store.has('isr:page:/posts/1')).toBe(false);
      expect(kv._store.has('isr:page:/posts/2')).toBe(false);
    });

    it('removes the tag index entry', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.invalidateTag('posts');
      expect(kv._store.has('isr:tag:posts')).toBe(false);
    });

    it('is a no-op when the tag does not exist', async () => {
      await expect(cache.invalidateTag('nonexistent')).resolves.toBeUndefined();
    });

    it('does not remove entries for other tags', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.set('/about', makeEntry('/about', ['static']));
      await cache.invalidateTag('posts');
      expect(kv._store.has('isr:page:/about')).toBe(true);
    });

    it('handles corrupt tag index gracefully', async () => {
      kv._store.set('isr:tag:corrupt', 'not-valid-json');
      await expect(cache.invalidateTag('corrupt')).resolves.toBeUndefined();
      expect(kv._store.has('isr:tag:corrupt')).toBe(false);
    });

    it('only invalidates entries matching the exact tag', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['posts']));
      await cache.set('/posts/2', makeEntry('/posts/2', ['post:2']));
      await cache.invalidateTag('posts');
      // Only /posts/1 is tagged 'posts'
      expect(kv._store.has('isr:page:/posts/1')).toBe(false);
      expect(kv._store.has('isr:page:/posts/2')).toBe(true);
    });
  });
});

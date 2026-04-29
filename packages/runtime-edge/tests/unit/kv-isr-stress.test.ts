// packages/runtime-edge/tests/unit/kv-isr-stress.test.ts
//
// Stress and edge-case tests for createKvIsrCache().
//
// Coverage:
//   - Many concurrent set() calls with tags overlapping heavily
//   - Many concurrent set() calls with many unique tags per page
//   - Concurrent set() + invalidateTag() for the same tag
//   - Concurrent set() + invalidatePath() for the same path
//   - Cross-isolate tag-lock simulation (simulating two worker instances
//     by using separate in-memory KV stores that share no tag-lock state)
//   - Rapid tag-add/remove cycles (flapping tags)
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { IsrCacheEntry } from '@lastshotlabs/slingshot-ssr';
import {
  type KvNamespace,
  configureRuntimeEdgeLogger,
  createKvIsrCache,
  flushTagLocks,
  tagLocksSize,
} from '../../src/kv-isr';

afterAll(() => {
  configureRuntimeEdgeLogger(null);
});

// ---------------------------------------------------------------------------
// In-memory KV mock
// ---------------------------------------------------------------------------

function inMemoryKv(): KvNamespace & { _store: Map<string, string> } {
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

describe('KV ISR stress tests', () => {
  let kv: ReturnType<typeof inMemoryKv>;
  let cache: ReturnType<typeof createKvIsrCache>;

  beforeEach(() => {
    kv = inMemoryKv();
    cache = createKvIsrCache(kv);
  });

  // -----------------------------------------------------------------------
  // Concurrent set() calls with overlapping tags
  // -----------------------------------------------------------------------

  describe('concurrent set() with heavily overlapping tags', () => {
    it('200 concurrent set() calls sharing a single tag produce a complete index', async () => {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 200; i++) {
        promises.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, ['shared'])));
      }
      await Promise.all(promises);
      await flushTagLocks();

      const idx = JSON.parse(kv._store.get('isr:tag:shared') ?? '[]') as string[];
      expect(idx.length).toBe(200);
      for (let i = 0; i < 200; i++) {
        expect(idx).toContain(`/p/${i}`);
      }
    });

    it('100 pages sharing 3 tags each all recorded correctly', async () => {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        const tags = [`group-${i % 10}`, `category-${i % 5}`, 'all'];
        promises.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, tags)));
      }
      await Promise.all(promises);
      await flushTagLocks();

      // The 'all' tag should contain all 100 paths
      const allIdx = JSON.parse(kv._store.get('isr:tag:all') ?? '[]') as string[];
      expect(allIdx.length).toBe(100);

      // Each group-N tag should contain 10 paths
      for (let g = 0; g < 10; g++) {
        const groupIdx = JSON.parse(
          kv._store.get(`isr:tag:group-${g}`) ?? '[]',
        ) as string[];
        expect(groupIdx.length).toBe(10);
      }

      // Each category-N tag should contain 20 paths
      for (let c = 0; c < 5; c++) {
        const catIdx = JSON.parse(
          kv._store.get(`isr:tag:category-${c}`) ?? '[]',
        ) as string[];
        expect(catIdx.length).toBe(20);
      }
    });

    it('no tag-lock entries leak after heavy concurrent usage', async () => {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, [`tag-${i}`])));
      }
      await Promise.all(promises);
      await flushTagLocks();
      expect(tagLocksSize()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent set() + invalidateTag() for the same tag
  // -----------------------------------------------------------------------

  describe('concurrent set() and invalidateTag()', () => {
    it('set and invalidateTag for the same tag do not cause unrecoverable errors', async () => {
      // Seed some entries
      await cache.set('/a', makeEntry('/a', ['stress']));
      await cache.set('/b', makeEntry('/b', ['stress']));

      // Concurrently: add more and invalidate
      const mixed: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        mixed.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, ['stress'])));
      }
      mixed.push(cache.invalidateTag('stress'));
      await Promise.allSettled(mixed);
      await flushTagLocks();

      // After invalidation + concurrent sets, the tag index may or may not exist
      // (race condition is expected — KV is eventually consistent). The important
      // thing is that neither operation throws and no tag-lock chain is poisoned.
      expect(tagLocksSize()).toBe(0);
    });

    it('invalidateTag during concurrent set does not poison subsequent tags', async () => {
      await cache.set('/a', makeEntry('/a', ['shared']));

      // Trigger concurrent set + invalidate
      await Promise.allSettled([
        cache.set('/b', makeEntry('/b', ['shared'])),
        cache.invalidateTag('shared'),
      ]);
      await flushTagLocks();

      // A fresh tag should still work
      await cache.set('/c', makeEntry('/c', ['fresh']));
      await flushTagLocks();
      const freshIdx = JSON.parse(kv._store.get('isr:tag:fresh') ?? '[]') as string[];
      expect(freshIdx).toEqual(['/c']);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent set() + invalidatePath() for the same path
  // -----------------------------------------------------------------------

  describe('concurrent set() and invalidatePath()', () => {
    it('set and invalidatePath for the same path does not lock up', async () => {
      await cache.set('/conflict', makeEntry('/conflict', ['t']));

      const results = await Promise.allSettled([
        cache.set('/conflict', makeEntry('/conflict', ['t', 'u'])),
        cache.invalidatePath('/conflict'),
      ]);
      await flushTagLocks();

      // At least one should succeed (or both). The point is no crash or hang.
      expect(results.some(r => r.status === 'fulfilled')).toBe(true);
      expect(tagLocksSize()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-isolate tag-lock simulation
  // -----------------------------------------------------------------------

  describe('cross-isolate tag-lock edge cases', () => {
    it('two separate KV stores with the same data are independent', async () => {
      // Simulate two worker instances with separate in-memory KV stores.
      // They share no tag-lock map, so concurrent operations would race
      // in real Cloudflare KV. Here we verify that separate KV stores
      // do not interfere.
      const kv1 = inMemoryKv();
      const kv2 = inMemoryKv();
      const cache1 = createKvIsrCache(kv1);
      const cache2 = createKvIsrCache(kv2);

      // Write the same page to both stores
      await Promise.all([
        cache1.set('/page', makeEntry('/page', ['tag-a'])),
        cache2.set('/page', makeEntry('/page', ['tag-b'])),
      ]);

      // Each store should have its own tag index
      expect(JSON.parse(kv1._store.get('isr:tag:tag-a') ?? '[]')).toEqual(['/page']);
      expect(kv1._store.has('isr:tag:tag-b')).toBe(false);
      expect(JSON.parse(kv2._store.get('isr:tag:tag-b') ?? '[]')).toEqual(['/page']);
      expect(kv2._store.has('isr:tag:tag-a')).toBe(false);

      // Invalidate independently
      await cache1.invalidateTag('tag-a');
      await cache2.invalidateTag('tag-b');

      // Each store should have the page key affected independently
      expect(kv1._store.has('isr:page:/page')).toBe(false);
      expect(kv2._store.has('isr:page:/page')).toBe(false);
    });

    it('concurrent set() across isolates produces correct eventual state', async () => {
      // Simulate two workers writing pages that share a tag.
      // In real CF KV these would race; in our test with separate
      // KV stores they are independent.
      const kv1 = inMemoryKv();
      const kv2 = inMemoryKv();
      const cache1 = createKvIsrCache(kv1);
      const cache2 = createKvIsrCache(kv2);

      await Promise.all([
        cache1.set('/worker-a', makeEntry('/worker-a', ['shared-tag'])),
        cache2.set('/worker-b', makeEntry('/worker-b', ['shared-tag'])),
      ]);

      // Each store only knows about its own writes
      expect(JSON.parse(kv1._store.get('isr:tag:shared-tag') ?? '[]')).toEqual(['/worker-a']);
      expect(JSON.parse(kv2._store.get('isr:tag:shared-tag') ?? '[]')).toEqual(['/worker-b']);
    });

    it('tag-lock map does not leak across separate cache instances', async () => {
      const kv1 = inMemoryKv();
      const kv2 = inMemoryKv();
      const cache1 = createKvIsrCache(kv1);
      const cache2 = createKvIsrCache(kv2);

      await Promise.all([
        cache1.set('/a', makeEntry('/a', ['t1'])),
        cache2.set('/b', makeEntry('/b', ['t2'])),
      ]);

      await flushTagLocks();

      // The tagLocks map is module-level, so both caches share it.
      // After flush, it should be empty (no leaks).
      expect(tagLocksSize()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Rapid tag-add/remove cycles
  // -----------------------------------------------------------------------

  describe('rapid tag flapping', () => {
    it('alternating tag additions and removals on the same path are stable', async () => {
      const path = '/flappy';

      // Cycle through tag sets rapidly
      for (let i = 0; i < 20; i++) {
        const tags = i % 2 === 0 ? ['even', 'all'] : ['odd', 'all'];
        await cache.set(path, makeEntry(path, tags));
      }
      await flushTagLocks();

      // After the last cycle, the tags should be ['odd', 'all']
      const allIdx = JSON.parse(kv._store.get('isr:tag:all') ?? '[]') as string[];
      expect(allIdx).toEqual([path]);

      const oddIdx = JSON.parse(kv._store.get('isr:tag:odd') ?? '[]') as string[];
      expect(oddIdx).toEqual([path]);

      // The 'even' tag should have been removed on the last cycle
      expect(kv._store.has('isr:tag:even')).toBe(false);
      expect(tagLocksSize()).toBe(0);
    });

    it('many paths alternate tags without leaking locks', async () => {
      const promises: Promise<void>[] = [];

      // Round 1: assign 'group-a' tag
      for (let i = 0; i < 50; i++) {
        promises.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, ['group-a'])));
      }
      await Promise.all(promises);
      promises.length = 0;

      // Round 2: switch to 'group-b' tag
      for (let i = 0; i < 50; i++) {
        promises.push(cache.set(`/p/${i}`, makeEntry(`/p/${i}`, ['group-b'])));
      }
      await Promise.all(promises);

      await flushTagLocks();

      // 'group-a' should be cleaned up
      expect(kv._store.has('isr:tag:group-a')).toBe(false);

      // 'group-b' should have all 50 paths
      const groupB = JSON.parse(kv._store.get('isr:tag:group-b') ?? '[]') as string[];
      expect(groupB.length).toBe(50);
      expect(tagLocksSize()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // HeartbeatTimeout integration
  // -----------------------------------------------------------------------

  describe('heartbeatTimeout integration in KV operations', () => {
    it('heartbeatTimeoutMs caps per-op timeout when shorter than operationTimeoutMs', async () => {
      let putResolved = false;
      const slowKv: KvNamespace = {
        ...kv,
        async put(key: string, value: string) {
          // Delay longer than the heartbeat but shorter than the op timeout
          await new Promise(r => setTimeout(r, 50));
          putResolved = true;
          await kv.put(key, value);
        },
      };

      // operationTimeoutMs=5000, heartbeatTimeoutMs=20 — heartbeat should win
      const c = createKvIsrCache(slowKv, {
        operationTimeoutMs: 5000,
        heartbeatTimeoutMs: 20,
      });

      // The put should time out due to the heartbeat
      await expect(c.set('/hb', makeEntry('/hb', ['t']))).rejects.toThrow(
        'timed out',
      );
    });

    it('heartbeatTimeoutMs=0 disables the heartbeat', async () => {
      let putResolved = false;
      const fastKv: KvNamespace = {
        ...kv,
        async put(key: string, value: string) {
          await new Promise(r => setTimeout(r, 10));
          putResolved = true;
          await kv.put(key, value);
        },
      };

      const c = createKvIsrCache(fastKv, {
        operationTimeoutMs: 5000,
        heartbeatTimeoutMs: 0,
      });

      await expect(c.set('/no-hb', makeEntry('/no-hb', ['t']))).resolves.toBeUndefined();
      expect(putResolved).toBe(true);
    });
  });
});

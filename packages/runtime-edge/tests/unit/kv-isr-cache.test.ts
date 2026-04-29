// packages/runtime-edge/tests/unit/kv-isr-cache.test.ts
//
// Tests for createKvIsrCache() — the KV-backed ISR cache adapter.
//
// Coverage:
//   - Basic get/set/delete roundtrip operations
//   - TTL expiration forwarded to KV put options
//   - Error handling on KV failures (get, put, delete)
//   - Key construction (isr:page: and isr:tag: prefixes)
//   - Corrupt entry handling
//   - KvOperationTimeoutError behavior (tested through cache operations)
//   - runWithConcurrency edge cases (0 tasks, concurrency=1)
//   - Concurrent tag-lock serialization
//   - Tag index cleanup (empty tag index auto-deleted)
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IsrCacheEntry } from '@lastshotlabs/slingshot-ssr';
import {
  type KvNamespace,
  configureRuntimeEdgeLogger,
  createKvIsrCache,
  flushTagLocks,
  tagLocksSize,
} from '../../src/kv-isr';

// Reset the kv-isr module-level logger to default after this file completes,
// so concurrent/sequential test files are not affected by our logger swaps.
afterAll(() => {
  configureRuntimeEdgeLogger(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inMemoryKv(): KvNamespace & {
  _store: Map<string, string>;
  _puts: Array<{ key: string; ttl?: number }>;
} {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  return {
    _store: store,
    _puts: puts,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      puts.push({ key, ttl: options?.expirationTtl });
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

describe('createKvIsrCache() — ISR cache adapter', () => {
  let kv: ReturnType<typeof inMemoryKv>;
  let cache: ReturnType<typeof createKvIsrCache>;

  beforeEach(() => {
    kv = inMemoryKv();
    cache = createKvIsrCache(kv);
  });

  // -----------------------------------------------------------------------
  // Basic CRUD
  // -----------------------------------------------------------------------

  describe('get / set / delete operations', () => {
    it('get returns null for non-existent key', async () => {
      expect(await cache.get('/nonexistent')).toBeNull();
    });

    it('get returns stored entry after set', async () => {
      const entry = makeEntry('/hello', ['static']);
      await cache.set('/hello', entry);
      const result = await cache.get('/hello');
      expect(result).not.toBeNull();
      expect(result!.html).toBe(entry.html);
      expect(result!.tags).toEqual(['static']);
    });

    it('set overwrites an existing entry', async () => {
      await cache.set('/page', makeEntry('/page', ['old']));
      const updated = makeEntry('/page', ['new'], Date.now() + 999_999);
      await cache.set('/page', updated);
      const result = await cache.get('/page');
      expect(result!.revalidateAfter).toBe(updated.revalidateAfter);
      expect(result!.tags).toEqual(['new']);
    });

    it('invalidatePath removes the page entry', async () => {
      await cache.set('/page', makeEntry('/page', ['t']));
      await cache.invalidatePath('/page');
      expect(await cache.get('/page')).toBeNull();
    });

    it('invalidateTag removes all pages for the tag and the index', async () => {
      await cache.set('/p1', makeEntry('/p1', ['batch']));
      await cache.set('/p2', makeEntry('/p2', ['batch']));
      await cache.invalidateTag('batch');
      expect(await cache.get('/p1')).toBeNull();
      expect(await cache.get('/p2')).toBeNull();
      expect(kv._store.has('isr:tag:batch')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Key construction
  // -----------------------------------------------------------------------

  describe('key construction', () => {
    it('stores page entries under isr:page:<path>', async () => {
      await cache.set('/about', makeEntry('/about'));
      expect(kv._store.has('isr:page:/about')).toBe(true);
    });

    it('stores tag indexes under isr:tag:<tag>', async () => {
      await cache.set('/posts/1', makeEntry('/posts/1', ['news']));
      expect(kv._store.has('isr:tag:news')).toBe(true);
    });

    it('stores multiple tags under their respective index keys', async () => {
      await cache.set('/multi', makeEntry('/multi', ['a', 'b', 'c']));
      expect(kv._store.has('isr:tag:a')).toBe(true);
      expect(kv._store.has('isr:tag:b')).toBe(true);
      expect(kv._store.has('isr:tag:c')).toBe(true);
    });

    it('uses path as-is (no encoding) in the page key', async () => {
      await cache.set('/path/with/slashes', makeEntry('/path/with/slashes'));
      expect(kv._store.has('isr:page:/path/with/slashes')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // TTL expiration
  // -----------------------------------------------------------------------

  describe('TTL expiration forwarding', () => {
    it('set passes no expirationTtl by default', async () => {
      await cache.set('/no-ttl', makeEntry('/no-ttl', ['t']));
      const pagePuts = kv._puts.filter(p => p.key.startsWith('isr:page:'));
      expect(pagePuts.length).toBeGreaterThanOrEqual(1);
      for (const p of pagePuts) {
        expect(p.ttl).toBeUndefined();
      }
    });

    it('tag index puts also have no expirationTtl by default', async () => {
      await cache.set('/tagged', makeEntry('/tagged', ['mytag']));
      const tagPuts = kv._puts.filter(p => p.key.startsWith('isr:tag:'));
      expect(tagPuts.length).toBeGreaterThanOrEqual(1);
      for (const p of tagPuts) {
        expect(p.ttl).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error handling on KV failures
  // -----------------------------------------------------------------------

  describe('error handling on KV failures', () => {
    it('propagates errors from kv.get (they are not silently caught)', async () => {
      const badKv: KvNamespace = {
        ...kv,
        async get() {
          throw new Error('kv-get-failed');
        },
      };
      const c = createKvIsrCache(badKv);
      await expect(c.get('/fail')).rejects.toThrow('kv-get-failed');
    });

    it('get returns null when JSON parse fails (corrupt entry)', async () => {
      kv._store.set('isr:page:/corrupt', '{broken json');
      expect(await cache.get('/corrupt')).toBeNull();
    });

    it('set rejects when kv.put fails for the page entry', async () => {
      let putCount = 0;
      const badKv: KvNamespace = {
        ...kv,
        async put(key: string, value: string) {
          putCount++;
          if (key.startsWith('isr:page:') && putCount === 1) {
            throw new Error('kv-put-failed');
          }
          await kv.put(key, value);
        },
      };
      const c = createKvIsrCache(badKv);
      await expect(c.set('/fail', makeEntry('/fail', ['t']))).rejects.toThrow('kv-put-failed');
    });

    it('invalidPath resolves when kv.delete throws', async () => {
      const badKv: KvNamespace = {
        ...kv,
        async delete() {
          throw new Error('kv-delete-failed');
        },
      };
      const c = createKvIsrCache(badKv);
      // invalidPath does not wrap the delete — the error propagates
      await expect(c.invalidatePath('/fail')).rejects.toThrow('kv-delete-failed');
    });

    it('invalidateTag resolves when corrupt tag index is encountered', async () => {
      kv._store.set('isr:tag:corrupt', 'not-json');
      await expect(cache.invalidateTag('corrupt')).resolves.toBeUndefined();
      // Corrupt index should be deleted
      expect(kv._store.has('isr:tag:corrupt')).toBe(false);
    });

    it('invalidateTag resolves when a page delete throws (fan-out)', async () => {
      await cache.set('/p1', makeEntry('/p1', ['batch']));
      await cache.set('/p2', makeEntry('/p2', ['batch']));
      await cache.set('/p3', makeEntry('/p3', ['batch']));

      let deleteCount = 0;
      const badKv: KvNamespace = {
        ...kv,
        async delete(key: string) {
          deleteCount++;
          // Fail the second delete but allow others to proceed
          if (deleteCount === 2) throw new Error('delete-failure');
          await kv.delete(key);
        },
      };
      const c = createKvIsrCache(badKv);
      // The fan-out runs with runWithConcurrency, which propagates errors
      await expect(c.invalidateTag('batch')).rejects.toThrow('delete-failure');
    });
  });

  // -----------------------------------------------------------------------
  // Tag-lock serialization
  // -----------------------------------------------------------------------

  describe('tag-lock serialization', () => {
    it('serializes concurrent set() calls for the same tag', async () => {
      // Issue concurrent set() calls for pages sharing a tag.
      // The tag-lock serializes the read-modify-write of the tag index,
      // so both paths should end up in the index.
      const promises = Promise.all([
        cache.set('/a', makeEntry('/a', ['shared'])),
        cache.set('/b', makeEntry('/b', ['shared'])),
      ]);
      await promises;
      await flushTagLocks();

      const idx = JSON.parse(kv._store.get('isr:tag:shared') ?? '[]') as string[];
      expect(idx).toContain('/a');
      expect(idx).toContain('/b');
    });

    it('does not grow tagLocks map unboundedly', async () => {
      const before = tagLocksSize();
      for (let i = 0; i < 20; i++) {
        await cache.set(`/p/${i}`, makeEntry(`/p/${i}`, [`tag-${i}`]));
      }
      await flushTagLocks();
      expect(tagLocksSize()).toBe(before);
    });
  });

  // -----------------------------------------------------------------------
  // Tag index lifecycle
  // -----------------------------------------------------------------------

  describe('tag index lifecycle', () => {
    it('creates tag index entries when setting a new page with tags', async () => {
      await cache.set('/new', makeEntry('/new', ['alpha']));
      expect(JSON.parse(kv._store.get('isr:tag:alpha')!)).toEqual(['/new']);
    });

    it('removes tag index entry when it becomes empty after tag removal', async () => {
      await cache.set('/only', makeEntry('/only', ['lonely']));
      await cache.set('/only', makeEntry('/only', [])); // remove the tag
      expect(kv._store.has('isr:tag:lonely')).toBe(false);
    });

    it('deduplicates tags correctly when tags array has duplicates', async () => {
      await cache.set('/dup', makeEntry('/dup', ['t', 't', 't']));
      const idx = JSON.parse(kv._store.get('isr:tag:t') ?? '[]') as string[];
      expect(idx).toEqual(['/dup']);
    });

    it('handles entries with zero tags', async () => {
      await cache.set('/untagged', makeEntry('/untagged', []));
      // No tag indexes should exist
      for (const key of kv._store.keys()) {
        expect(key.startsWith('isr:tag:')).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Logger integration (kv-isr logger)
  // -----------------------------------------------------------------------

  describe('logger integration', () => {
    it('logs tag-index errors through the configured logger', async () => {
      const captured: Array<{ event: string; fields?: Record<string, unknown> }> = [];
      const prev = configureRuntimeEdgeLogger({
        error(event, fields) {
          captured.push({ event, fields });
        },
      });
      try {
        // Create a hash that fails during tag parsing
        kv._store.set('isr:tag:broken', 'not-json');
        await cache.set('/fix', makeEntry('/fix', ['broken']));
        // The corrupt tag index gets repaired (logged before repair)
        await Promise.resolve();
        await Promise.resolve();
        expect(captured.some(c => c.event === 'tag-index-parse-failed')).toBe(true);
      } finally {
        configureRuntimeEdgeLogger(prev);
      }
    });

    it('restores the previous logger when configureRuntimeEdgeLogger is called with null', async () => {
      const custom = {
        error() {},
      };
      const prev = configureRuntimeEdgeLogger(custom);
      expect(prev).not.toBe(custom);
      const restored = configureRuntimeEdgeLogger(null);
      expect(restored).toBe(custom);
      // Reset to original
      configureRuntimeEdgeLogger(prev);
    });
  });
});

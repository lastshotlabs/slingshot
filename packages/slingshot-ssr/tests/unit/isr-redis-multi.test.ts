// packages/slingshot-ssr/tests/unit/isr-redis-multi.test.ts
//
// Tests for the MULTI/EXEC behavior of the Redis ISR adapter.
//
// The set() implementation must wrap the page SET and per-tag SADDs in a
// single MULTI/EXEC transaction so that a failed SADD does not leave a
// page entry behind without its tag indexes.
import { describe, expect, it } from 'bun:test';
import { createRedisIsrCache } from '../../src/isr/redis';
import type { IsrCacheEntry, RedisLike, RedisMultiLike } from '../../src/isr/types';

interface FakeRedisOptions {
  /**
   * When set, the SADD inside the transaction throws this error before
   * the transaction can commit. Simulates a runtime failure (network drop,
   * RESP error) that aborts the entire MULTI/EXEC.
   */
  saddThrows?: Error;
  /**
   * When set, the first call to exec() returns null (transaction aborted —
   * e.g. WATCH conflict). The adapter should retry once.
   */
  firstExecAbort?: boolean;
}

interface FakeRedis extends RedisLike {
  _store: Map<string, string>;
  _sets: Map<string, Set<string>>;
  _execCount: number;
  _committedCount: number;
}

/**
 * Build a Redis fake whose `multi()` queues commands but only commits to the
 * underlying store on a successful `exec()`. If a queued SADD is configured
 * to throw, the whole transaction is rolled back (no SET visible).
 */
function createFakeRedis(opts: FakeRedisOptions = {}): FakeRedis {
  const _store = new Map<string, string>();
  const _sets = new Map<string, Set<string>>();
  const fake: FakeRedis = {
    _store,
    _sets,
    _execCount: 0,
    _committedCount: 0,

    async set(key, value) {
      _store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return _store.get(key) ?? null;
    },
    async del(...keys) {
      for (const k of keys) {
        _store.delete(k);
        _sets.delete(k);
      }
      return keys.length;
    },
    async sadd(key, ...members) {
      if (!_sets.has(key)) _sets.set(key, new Set());
      for (const m of members) _sets.get(key)!.add(m);
      return members.length;
    },
    async smembers(key) {
      return Array.from(_sets.get(key) ?? []);
    },
    async srem(key, ...members) {
      const s = _sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed++;
      }
      return removed;
    },

    multi(): RedisMultiLike {
      type Op =
        | { kind: 'set'; key: string; value: string }
        | { kind: 'sadd'; key: string; members: string[] };
      const ops: Op[] = [];
      const tx: RedisMultiLike = {
        set(key: string, value: string) {
          ops.push({ kind: 'set', key, value });
          return tx;
        },
        sadd(key: string, ...members: string[]) {
          ops.push({ kind: 'sadd', key, members });
          return tx;
        },
        async exec(): Promise<unknown[] | null> {
          fake._execCount++;
          // First-exec WATCH-conflict simulation — abort transaction without
          // applying any of the queued commands. The adapter retries once.
          if (opts.firstExecAbort && fake._execCount === 1) {
            return null;
          }

          // Apply commands "atomically": stage to local maps, then flush.
          // If any SADD is configured to throw, we throw before flushing so
          // that none of the staged writes are visible in the underlying store.
          const stagedStore = new Map<string, string>();
          const stagedSets = new Map<string, string[]>();
          for (const op of ops) {
            if (op.kind === 'set') {
              stagedStore.set(op.key, op.value);
            } else {
              if (opts.saddThrows) {
                throw opts.saddThrows;
              }
              const cur = stagedSets.get(op.key) ?? [];
              cur.push(...op.members);
              stagedSets.set(op.key, cur);
            }
          }

          // Flush — this is the only place writes become visible.
          for (const [k, v] of stagedStore) _store.set(k, v);
          for (const [k, members] of stagedSets) {
            if (!_sets.has(k)) _sets.set(k, new Set());
            for (const m of members) _sets.get(k)!.add(m);
          }
          fake._committedCount++;
          return [];
        },
      };
      return tx;
    },
  };
  return fake;
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

describe('ISR Redis MULTI/EXEC — atomic set', () => {
  it('rolls back the SET when SADD throws inside the transaction', async () => {
    const fake = createFakeRedis({ saddThrows: new Error('SADD failed') });
    const cache = createRedisIsrCache(fake);

    let threw: unknown;
    try {
      await cache.set('/posts', makeEntry({ tags: ['posts', 'home'] }));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);

    // The page SET must NOT be visible — the entire transaction was aborted.
    expect(fake._store.has('isr:page:/posts')).toBe(false);
    expect(await cache.get('/posts')).toBeNull();
    // Tag indexes must also remain empty.
    expect(fake._sets.has('isr:tag:posts')).toBe(false);
    expect(fake._sets.has('isr:tag:home')).toBe(false);
    // Nothing committed.
    expect(fake._committedCount).toBe(0);
  });

  it('commits the SET and all SADDs when the transaction succeeds', async () => {
    const fake = createFakeRedis();
    const cache = createRedisIsrCache(fake);

    await cache.set('/posts', makeEntry({ tags: ['posts', 'post:1'] }));

    expect(fake._store.has('isr:page:/posts')).toBe(true);
    expect(fake._sets.get('isr:tag:posts')?.has('/posts')).toBe(true);
    expect(fake._sets.get('isr:tag:post:1')?.has('/posts')).toBe(true);
    expect(fake._committedCount).toBe(1);
  });

  it('retries once when EXEC returns null (transaction aborted)', async () => {
    const fake = createFakeRedis({ firstExecAbort: true });
    const cache = createRedisIsrCache(fake);

    await cache.set('/posts', makeEntry({ tags: ['posts'] }));

    // Two exec() invocations — initial null + successful retry.
    expect(fake._execCount).toBe(2);
    expect(fake._committedCount).toBe(1);
    expect(fake._store.has('isr:page:/posts')).toBe(true);
  });

  it('does not perform a tag SADD when there are no tags', async () => {
    const fake = createFakeRedis();
    const cache = createRedisIsrCache(fake);

    await cache.set('/no-tags', makeEntry({ tags: [] }));

    // The SET committed, but no tag sets exist.
    expect(fake._store.has('isr:page:/no-tags')).toBe(true);
    expect(fake._sets.size).toBe(0);
  });
});

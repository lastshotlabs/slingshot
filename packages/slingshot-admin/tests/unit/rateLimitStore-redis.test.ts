import { describe, expect, test } from 'bun:test';
import {
  type RedisRateLimitClientLike,
  type RedisRateLimitMultiLike,
  createRedisRateLimitStore,
} from '../../src/lib/rateLimitStore';

interface MultiCall {
  cmd: 'incr' | 'pexpire';
  args: unknown[];
}

interface Fake {
  client: RedisRateLimitClientLike;
  /** Inspector for the per-call command sequences captured from `multi()`. */
  txs: MultiCall[][];
  state: Map<string, { value: number; ttlMs: number; expiresAt: number }>;
}

/**
 * Build a fake redis client supporting just the operations the rate limiter
 * uses: INCR, PEXPIRE, PTTL, and a chainable MULTI builder. State is stored
 * in a Map; TTLs use absolute expiry timestamps so tests can advance time
 * by mutating Date.now or by sleeping briefly.
 */
function buildFakeRedis(): Fake {
  const state = new Map<string, { value: number; ttlMs: number; expiresAt: number }>();
  const txs: MultiCall[][] = [];

  function maybeExpire(key: string) {
    const entry = state.get(key);
    if (!entry) return;
    if (entry.ttlMs > 0 && entry.expiresAt <= Date.now()) {
      state.delete(key);
    }
  }

  function incrSync(key: string) {
    maybeExpire(key);
    const existing = state.get(key);
    const next = existing ? existing.value + 1 : 1;
    state.set(key, {
      value: next,
      ttlMs: existing?.ttlMs ?? 0,
      expiresAt: existing?.expiresAt ?? 0,
    });
    return next;
  }

  function pexpireSync(key: string, ms: number, opts: { nx: boolean }) {
    const entry = state.get(key);
    if (!entry) return 0;
    if (opts.nx && entry.ttlMs > 0) return 0; // NX: skip if a TTL is already set
    entry.ttlMs = ms;
    entry.expiresAt = Date.now() + ms;
    return 1;
  }

  const client: RedisRateLimitClientLike = {
    async incr(key) {
      return incrSync(key);
    },
    async pttl(key) {
      maybeExpire(key);
      const entry = state.get(key);
      if (!entry) return -2;
      if (entry.ttlMs <= 0) return -1;
      return Math.max(0, entry.expiresAt - Date.now());
    },
    async pexpire(key, ms) {
      const entry = state.get(key);
      if (!entry) return 0;
      entry.ttlMs = ms;
      entry.expiresAt = Date.now() + ms;
      return 1;
    },
    multi() {
      const calls: MultiCall[] = [];
      txs.push(calls);
      const builder: RedisRateLimitMultiLike = {
        incr(key) {
          calls.push({ cmd: 'incr', args: [key] });
          return builder;
        },
        pexpire(key, ms, nx) {
          calls.push({ cmd: 'pexpire', args: [key, ms, nx] });
          return builder;
        },
        async exec() {
          const results: unknown[] = [];
          for (const call of calls) {
            if (call.cmd === 'incr') {
              const [k] = call.args as [string];
              results.push(incrSync(k));
            } else {
              const [k, ms, nx] = call.args as [string, number, 'NX'];
              results.push(pexpireSync(k, ms, { nx: nx === 'NX' }));
            }
          }
          return results;
        },
      };
      return builder;
    },
  };

  return { client, txs, state };
}

describe('createRedisRateLimitStore', () => {
  test('first hit issues MULTI with INCR + PEXPIRE NX', async () => {
    const fake = buildFakeRedis();
    const store = createRedisRateLimitStore({ client: fake.client });

    const result = await store.hit('k', { limit: 3, windowMs: 60_000 });

    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
    expect(fake.txs).toHaveLength(1);
    expect(fake.txs[0]).toEqual([
      { cmd: 'incr', args: ['slingshot:admin:rl:k'] },
      { cmd: 'pexpire', args: ['slingshot:admin:rl:k', 60_000, 'NX'] },
    ]);
  });

  test('subsequent hits within window increment the same counter and do not extend TTL', async () => {
    const fake = buildFakeRedis();
    const store = createRedisRateLimitStore({ client: fake.client });
    const opts = { limit: 2, windowMs: 60_000 };

    const first = await store.hit('k', opts);
    const second = await store.hit('k', opts);
    const third = await store.hit('k', opts);

    expect(first.exceeded).toBe(false);
    expect(second.exceeded).toBe(false);
    expect(third.exceeded).toBe(true);
    expect(third.count).toBe(3);

    // Every hit issues MULTI; PEXPIRE NX is a no-op once TTL is set.
    expect(fake.txs).toHaveLength(3);
    // The window's expiry timestamp must not advance after the first hit.
    const expiresAt = fake.state.get('slingshot:admin:rl:k')?.expiresAt;
    expect(expiresAt).toBeDefined();
    expect(Math.abs((expiresAt ?? 0) - first.resetAt)).toBeLessThan(50);
  });

  test('window expiry resets the counter on the next hit', async () => {
    const fake = buildFakeRedis();
    const store = createRedisRateLimitStore({ client: fake.client });
    const opts = { limit: 1, windowMs: 1 };

    const first = await store.hit('k', opts);
    expect(first.exceeded).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 5));

    const second = await store.hit('k', opts);
    expect(second.count).toBe(1);
    expect(second.exceeded).toBe(false);
  });

  test('honours custom keyPrefix', async () => {
    const fake = buildFakeRedis();
    const store = createRedisRateLimitStore({ client: fake.client, keyPrefix: 'app1:rl:' });

    await store.hit('foo', { limit: 5, windowMs: 60_000 });

    expect(fake.txs[0]?.[0]).toEqual({ cmd: 'incr', args: ['app1:rl:foo'] });
    expect(fake.state.has('app1:rl:foo')).toBe(true);
  });

  test('falls back to direct INCR when MULTI exec returns null', async () => {
    const fake = buildFakeRedis();
    // Override multi() to abort.
    const originalMulti = fake.client.multi.bind(fake.client);
    let aborted = false;
    fake.client.multi = () => {
      const builder = originalMulti();
      const wrapped: RedisRateLimitMultiLike = {
        incr: (...args) => {
          builder.incr(...(args as Parameters<RedisRateLimitMultiLike['incr']>));
          return wrapped;
        },
        pexpire: (...args) => {
          builder.pexpire(...(args as Parameters<RedisRateLimitMultiLike['pexpire']>));
          return wrapped;
        },
        async exec() {
          if (!aborted) {
            aborted = true;
            return null;
          }
          return builder.exec();
        },
      };
      return wrapped;
    };

    const store = createRedisRateLimitStore({ client: fake.client });
    const result = await store.hit('k', { limit: 3, windowMs: 60_000 });

    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });
});

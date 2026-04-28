import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createMemoryOperationIdempotencyAdapter,
  makeIdempotencyKey,
  withIdempotency,
} from '../src/idempotency/index';

let nowSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
});

describe('makeIdempotencyKey', () => {
  test('joins parts with a colon', () => {
    expect(String(makeIdempotencyKey(['mail', 'send', 42] as never))).toBe('mail:send:42');
  });

  test('coerces numeric parts to strings', () => {
    expect(String(makeIdempotencyKey([1, 2, 3] as never))).toBe('1:2:3');
  });

  test('rejects empty parts', () => {
    expect(() => makeIdempotencyKey([])).toThrow('idempotency key parts cannot be empty');
  });
});

describe('withIdempotency', () => {
  test('first call invokes fn, second call returns cached payload as deduped', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter();
    const key = makeIdempotencyKey(['op', 'a']);
    let calls = 0;
    const fn = async () => {
      calls++;
      return { value: calls };
    };

    const first = await withIdempotency(adapter, key, fn);
    expect(first).toEqual({ result: { value: 1 }, deduped: false });
    expect(calls).toBe(1);

    const second = await withIdempotency(adapter, key, fn);
    expect(second).toEqual({ result: { value: 1 }, deduped: true });
    expect(calls).toBe(1);
  });

  test('TTL expiration causes re-execution', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter();
    const key = makeIdempotencyKey(['op', 'ttl']);

    let now = 1_000;
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);

    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    const first = await withIdempotency(adapter, key, fn, { ttlMs: 100 });
    expect(first).toEqual({ result: 1, deduped: false });

    // Within TTL — cached.
    now = 1_050;
    const cached = await withIdempotency(adapter, key, fn, { ttlMs: 100 });
    expect(cached).toEqual({ result: 1, deduped: true });
    expect(calls).toBe(1);

    // After TTL — re-runs.
    now = 1_200;
    const replayed = await withIdempotency(adapter, key, fn, { ttlMs: 100 });
    expect(replayed).toEqual({ result: 2, deduped: false });
    expect(calls).toBe(2);
  });

  test('reuseCachedPayload: false re-runs fn but still records', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter();
    const key = makeIdempotencyKey(['op', 'no-reuse']);
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    const first = await withIdempotency(adapter, key, fn, { reuseCachedPayload: false });
    expect(first).toEqual({ result: 1, deduped: false });
    expect(calls).toBe(1);

    const second = await withIdempotency(adapter, key, fn, { reuseCachedPayload: false });
    expect(second).toEqual({ result: 2, deduped: false });
    expect(calls).toBe(2);

    // Adapter should still hold the latest recorded payload.
    const stored = await adapter.get(key);
    expect(stored?.payload).toBe(2);
  });
});

describe('createMemoryOperationIdempotencyAdapter', () => {
  test('FIFO eviction when maxEntries is exceeded', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter({ maxEntries: 2 });
    const k1 = makeIdempotencyKey(['k', 1]);
    const k2 = makeIdempotencyKey(['k', 2]);
    const k3 = makeIdempotencyKey(['k', 3]);

    await adapter.set(k1, 'one');
    await adapter.set(k2, 'two');
    await adapter.set(k3, 'three'); // evicts k1

    expect(await adapter.get(k1)).toBeUndefined();
    expect((await adapter.get(k2))?.payload).toBe('two');
    expect((await adapter.get(k3))?.payload).toBe('three');
  });

  test('expired entries are dropped lazily on get', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter({ defaultTtlMs: 50 });
    const key = makeIdempotencyKey(['expire']);

    let now = 5_000;
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);

    await adapter.set(key, 'payload');
    expect((await adapter.get(key))?.payload).toBe('payload');

    now = 5_100;
    expect(await adapter.get(key)).toBeUndefined();
  });

  test('set with the same key updates payload without growing entry count', async () => {
    const adapter = createMemoryOperationIdempotencyAdapter({ maxEntries: 2 });
    const k1 = makeIdempotencyKey(['k', 1]);
    const k2 = makeIdempotencyKey(['k', 2]);

    await adapter.set(k1, 'one');
    await adapter.set(k2, 'two');
    await adapter.set(k1, 'one-updated'); // not a new entry — should not evict k2

    expect((await adapter.get(k1))?.payload).toBe('one-updated');
    expect((await adapter.get(k2))?.payload).toBe('two');
  });
});

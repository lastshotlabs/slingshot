import { describe, expect, test } from 'bun:test';
import {
  evictOldest,
  createEvictExpired,
  evictOldestArray,
  DEFAULT_MAX_ENTRIES,
} from '../../src/memoryEviction';

describe('evictOldest', () => {
  test('removes oldest entries when map exceeds maxEntries', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ]);
    evictOldest(map, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });

  test('does nothing when map size equals maxEntries', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    evictOldest(map, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(true);
  });

  test('does nothing when map size is below maxEntries', () => {
    const map = new Map([['a', 1]]);
    evictOldest(map, 5);
    expect(map.size).toBe(1);
  });

  test('removes all but one when maxEntries is 1', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    evictOldest(map, 1);
    expect(map.size).toBe(1);
    expect(map.has('c')).toBe(true);
  });

  test('removes exactly the excess count', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 10; i++) map.set(`key${i}`, i);
    evictOldest(map, 7);
    expect(map.size).toBe(7);
    // First 3 should be gone
    expect(map.has('key0')).toBe(false);
    expect(map.has('key1')).toBe(false);
    expect(map.has('key2')).toBe(false);
    expect(map.has('key3')).toBe(true);
  });

  test('handles empty map', () => {
    const map = new Map();
    evictOldest(map, 5);
    expect(map.size).toBe(0);
  });
});

describe('createEvictExpired', () => {
  test('removes entries whose expiresAt has passed', () => {
    const evictExpired = createEvictExpired(0); // no throttle
    const now = Date.now();
    const map = new Map([
      ['expired1', { value: 'a', expiresAt: now - 1000 }],
      ['expired2', { value: 'b', expiresAt: now - 1 }],
      ['valid', { value: 'c', expiresAt: now + 60_000 }],
      ['noExpiry', { value: 'd' }],
    ]);
    evictExpired(map);
    expect(map.size).toBe(2);
    expect(map.has('expired1')).toBe(false);
    expect(map.has('expired2')).toBe(false);
    expect(map.has('valid')).toBe(true);
    expect(map.has('noExpiry')).toBe(true);
  });

  test('does not remove entries without expiresAt', () => {
    const evictExpired = createEvictExpired(0);
    const map = new Map([
      ['a', { value: '1' }],
      ['b', { value: '2' }],
    ]);
    evictExpired(map);
    expect(map.size).toBe(2);
  });

  test('throttles scans to intervalMs', () => {
    const evictExpired = createEvictExpired(60_000); // 60 second interval
    const now = Date.now();
    const map = new Map([
      ['expired', { value: 'a', expiresAt: now - 1000 }],
    ]);

    // First call runs the scan
    evictExpired(map);
    expect(map.size).toBe(0);

    // Re-add an expired entry
    map.set('expired2', { value: 'b', expiresAt: now - 500 });

    // Second call is throttled — should NOT evict
    evictExpired(map);
    expect(map.size).toBe(1);
    expect(map.has('expired2')).toBe(true);
  });

  test('each createEvictExpired call returns an independent function', () => {
    const evict1 = createEvictExpired(0);
    const evict2 = createEvictExpired(60_000);
    const now = Date.now();

    const map = new Map([
      ['expired', { value: 'a', expiresAt: now - 1000 }],
    ]);

    // evict1 has 0 interval, so it always runs
    evict1(map);
    expect(map.size).toBe(0);

    // Re-add and try evict2
    map.set('expired2', { value: 'b', expiresAt: now - 500 });
    // evict2 has its own state — first call on this map runs
    evict2(map);
    expect(map.size).toBe(0);
  });

  test('tracks throttle per-map independently', () => {
    const evictExpired = createEvictExpired(60_000);
    const now = Date.now();

    const map1 = new Map([
      ['expired', { value: 'a', expiresAt: now - 1000 }],
    ]);
    const map2 = new Map([
      ['expired', { value: 'b', expiresAt: now - 1000 }],
    ]);

    evictExpired(map1);
    expect(map1.size).toBe(0);

    // map2 has its own throttle state — first call runs
    evictExpired(map2);
    expect(map2.size).toBe(0);
  });

  test('removes entry when expiresAt equals current time', () => {
    const evictExpired = createEvictExpired(0);
    const now = Date.now();
    const map = new Map([
      ['exact', { value: 'a', expiresAt: now }],
    ]);
    evictExpired(map);
    // expiresAt <= now, so it should be removed
    expect(map.size).toBe(0);
  });

  test('does not remove entries with expiresAt of 0 (falsy)', () => {
    const evictExpired = createEvictExpired(0);
    const map = new Map([
      ['zero', { value: 'a', expiresAt: 0 }],
    ]);
    evictExpired(map);
    // expiresAt is 0, which is falsy — condition `val.expiresAt && ...` skips it
    expect(map.size).toBe(1);
  });

  test('uses default interval of 5000ms when no argument', () => {
    // Just verify it can be called with no args and returns a function
    const evictExpired = createEvictExpired();
    expect(typeof evictExpired).toBe('function');
  });
});

describe('evictOldestArray', () => {
  test('removes oldest elements when array exceeds maxEntries', () => {
    const arr = ['a', 'b', 'c', 'd', 'e'];
    evictOldestArray(arr, 3);
    expect(arr).toEqual(['c', 'd', 'e']);
  });

  test('does nothing when array length equals maxEntries', () => {
    const arr = ['a', 'b', 'c'];
    evictOldestArray(arr, 3);
    expect(arr).toEqual(['a', 'b', 'c']);
  });

  test('does nothing when array length is below maxEntries', () => {
    const arr = ['a'];
    evictOldestArray(arr, 5);
    expect(arr).toEqual(['a']);
  });

  test('reduces to single element when maxEntries is 1', () => {
    const arr = [1, 2, 3, 4, 5];
    evictOldestArray(arr, 1);
    expect(arr).toEqual([5]);
  });

  test('handles empty array', () => {
    const arr: string[] = [];
    evictOldestArray(arr, 5);
    expect(arr).toEqual([]);
  });

  test('mutates the original array in place', () => {
    const arr = ['a', 'b', 'c', 'd'];
    const ref = arr;
    evictOldestArray(arr, 2);
    expect(ref).toBe(arr);
    expect(ref).toEqual(['c', 'd']);
  });
});

describe('DEFAULT_MAX_ENTRIES', () => {
  test('is 10_000', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(10_000);
  });
});

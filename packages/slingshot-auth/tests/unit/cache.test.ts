/**
 * Unit tests for the in-memory cache adapter (createMemoryCacheAdapter).
 *
 * Covers:
 * - set/get round-trip
 * - get non-existent key returns null
 * - del removes entries
 * - TTL-based expiry
 * - Overwrite same key
 * - delPattern with glob wildcards
 * - isReady always returns true
 * - Key isolation
 * - Set without TTL (indefinite persistence)
 * - Numeric string values
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryCacheAdapter } from '../../src/lib/cache';
import type { ICacheAdapter } from '../../src/lib/cache';

let cache: ICacheAdapter;

beforeEach(() => {
  cache = createMemoryCacheAdapter();
});

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

describe('memory cache adapter', () => {
  test('set/get round-trip stores and retrieves a value', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get('key1');
    expect(result).toBe('value1');
  });

  test('get returns null for a non-existent key', async () => {
    const result = await cache.get('missing-key');
    expect(result).toBeNull();
  });

  test('del removes a key so subsequent get returns null', async () => {
    await cache.set('key1', 'value1');
    await cache.del('key1');
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });

  test('del on non-existent key does not throw', async () => {
    // Should be a no-op
    await cache.del('nonexistent');
  });

  test('overwrite: setting same key twice returns the latest value', async () => {
    await cache.set('key1', 'first');
    await cache.set('key1', 'second');
    const result = await cache.get('key1');
    expect(result).toBe('second');
  });

  test('isReady returns true for memory adapter', () => {
    expect(cache.isReady()).toBe(true);
  });

  test('name is "memory"', () => {
    expect(cache.name).toBe('memory');
  });

  // ---------------------------------------------------------------------------
  // Key isolation
  // ---------------------------------------------------------------------------

  test('different keys do not interfere with each other', async () => {
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.set('c', '3');

    expect(await cache.get('a')).toBe('1');
    expect(await cache.get('b')).toBe('2');
    expect(await cache.get('c')).toBe('3');

    await cache.del('b');
    expect(await cache.get('a')).toBe('1');
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toBe('3');
  });

  // ---------------------------------------------------------------------------
  // TTL
  // ---------------------------------------------------------------------------

  test('entry expires after TTL elapses', async () => {
    // TTL is in seconds; use 0.05s (50ms)
    await cache.set('ephemeral', 'gone-soon', 0.05);
    // Immediately available
    expect(await cache.get('ephemeral')).toBe('gone-soon');

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(await cache.get('ephemeral')).toBeNull();
  });

  test('set without TTL persists indefinitely', async () => {
    await cache.set('permanent', 'stays');
    // Wait a bit to ensure it does not expire
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await cache.get('permanent')).toBe('stays');
  });

  test('overwriting with a new TTL replaces the expiry', async () => {
    await cache.set('key1', 'short', 0.05);
    // Overwrite with no TTL (indefinite)
    await cache.set('key1', 'long');
    await new Promise(resolve => setTimeout(resolve, 80));
    // Should still be present since the second set had no TTL
    expect(await cache.get('key1')).toBe('long');
  });

  // ---------------------------------------------------------------------------
  // Numeric values
  // ---------------------------------------------------------------------------

  test('stores and retrieves numeric string values', async () => {
    await cache.set('count', '42');
    const result = await cache.get('count');
    expect(result).toBe('42');

    await cache.set('float', '3.14');
    expect(await cache.get('float')).toBe('3.14');

    await cache.set('zero', '0');
    expect(await cache.get('zero')).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // delPattern
  // ---------------------------------------------------------------------------

  test('delPattern removes keys matching a prefix wildcard', async () => {
    await cache.set('user:1:name', 'Alice');
    await cache.set('user:1:email', 'alice@test.com');
    await cache.set('user:2:name', 'Bob');
    await cache.set('other:key', 'safe');

    await cache.delPattern('user:1:*');

    expect(await cache.get('user:1:name')).toBeNull();
    expect(await cache.get('user:1:email')).toBeNull();
    // Unmatched keys remain
    expect(await cache.get('user:2:name')).toBe('Bob');
    expect(await cache.get('other:key')).toBe('safe');
  });

  test('delPattern removes keys matching a suffix wildcard', async () => {
    await cache.set('rate:ip:1.2.3.4', '5');
    await cache.set('rate:ip:5.6.7.8', '3');
    await cache.set('rate:user:abc', '10');

    await cache.delPattern('rate:ip:*');

    expect(await cache.get('rate:ip:1.2.3.4')).toBeNull();
    expect(await cache.get('rate:ip:5.6.7.8')).toBeNull();
    expect(await cache.get('rate:user:abc')).toBe('10');
  });

  test('delPattern with no matching keys is a no-op', async () => {
    await cache.set('keep', 'this');
    await cache.delPattern('nope:*');
    expect(await cache.get('keep')).toBe('this');
  });

  test('delPattern with wildcard in the middle', async () => {
    await cache.set('a:x:z', '1');
    await cache.set('a:y:z', '2');
    await cache.set('a:x:w', '3');
    await cache.set('b:x:z', '4');

    await cache.delPattern('a:*:z');

    expect(await cache.get('a:x:z')).toBeNull();
    expect(await cache.get('a:y:z')).toBeNull();
    expect(await cache.get('a:x:w')).toBe('3');
    expect(await cache.get('b:x:z')).toBe('4');
  });

  // ---------------------------------------------------------------------------
  // Factory isolation
  // ---------------------------------------------------------------------------

  test('separate adapter instances have independent stores', async () => {
    const cache2 = createMemoryCacheAdapter();
    await cache.set('shared-key', 'from-cache-1');
    await cache2.set('shared-key', 'from-cache-2');

    expect(await cache.get('shared-key')).toBe('from-cache-1');
    expect(await cache2.get('shared-key')).toBe('from-cache-2');
  });
});

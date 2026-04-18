import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { beforeEach, describe, expect, test } from 'bun:test';

let stores: ReturnType<typeof createMemoryAuthAdapter>;

describe('memoryGetCache expiry', () => {
  beforeEach(() => {
    // Fresh instance ensures a clean store
    stores = createMemoryAuthAdapter();
  });

  test('returns cached value before expiry', () => {
    stores.memorySetCache('key1', 'value1', 60);
    expect(stores.memoryGetCache('key1')).toBe('value1');
  });

  test('returns null for expired cache entries', () => {
    // Setting a negative TTL creates an entry with expiresAt in the past
    stores.memorySetCache('exp-key', 'val', -1);
    const result = stores.memoryGetCache('exp-key');
    expect(result).toBeNull();
  });

  test('deletes expired entry from store on access', () => {
    stores.memorySetCache('exp-key2', 'val2', -1);
    // First access returns null and deletes
    stores.memoryGetCache('exp-key2');
    // Second access also returns null (entry gone)
    expect(stores.memoryGetCache('exp-key2')).toBeNull();
  });
});

/**
 * dbNative deep pagination guard tests.
 *
 * The dbNative provider materializes the full filtered result set before
 * slicing. To prevent a heap-pressure DoS vector we hard-cap the effective
 * `offset` and reject anything past it.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { createDbNativeProvider } from '../src/providers/dbNative';
import type { SearchProvider } from '../src/types/provider';

describe('dbNative deep pagination', () => {
  let provider: SearchProvider;

  beforeEach(async () => {
    provider = createDbNativeProvider();
    await provider.connect();
    await provider.createOrUpdateIndex('items', {
      searchableFields: ['title'],
      filterableFields: [],
      sortableFields: [],
      facetableFields: [],
    });
    // A small fixture is enough — the cap is on the request, not the data set.
    await provider.indexDocuments(
      'items',
      Array.from({ length: 50 }, (_, i) => ({ id: `i-${i}`, title: `Item ${i}` })),
      'id',
    );
  });

  it('accepts offset up to the documented cap (10_000)', async () => {
    // 10_000 is the boundary — equal is allowed, greater is rejected.
    await expect(
      provider.search('items', { q: '*', offset: 10_000, limit: 10 }),
    ).resolves.toBeTruthy();
  });

  it('rejects deep offsets beyond the cap', async () => {
    await expect(provider.search('items', { q: '*', offset: 10_001, limit: 10 })).rejects.toThrow(
      /offset 10001 exceeds the safe maximum/,
    );
  });

  it('also rejects deep page-based pagination that resolves past the cap', async () => {
    // page=1001 with hitsPerPage=20 → effective offset = 20_000
    await expect(provider.search('items', { q: '*', page: 1001, hitsPerPage: 20 })).rejects.toThrow(
      /exceeds the safe maximum/,
    );
  });
});

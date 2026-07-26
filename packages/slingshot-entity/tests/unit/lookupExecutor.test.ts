/**
 * Unit tests for the lookup executor's param-resolution semantics:
 *   - omitted / `undefined` param → constraint is dropped (wildcard)
 *   - `null` param → matches records where the field is null
 *   - primitive param → exact match
 *
 * Targets the memory backend (no DB setup required); the matcher logic
 * is shared across all 5 backends via `resolveParam`.
 */
import { describe, expect, it } from 'bun:test';
import type { LookupOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { lookupMemory } from '../../src/configDriven/operationExecutors/lookup';

interface MemoryEntry {
  record: Record<string, unknown>;
  expiresAt?: number;
}

const noopConfig = {} as ResolvedEntityConfig;

function makeStore(records: Record<string, unknown>[]): Map<string, MemoryEntry> {
  const store = new Map<string, MemoryEntry>();
  for (const r of records) store.set(r['id'] as string, { record: r });
  return store;
}

function mkExecutor(op: LookupOpConfig, store: Map<string, MemoryEntry>) {
  return lookupMemory(
    op,
    noopConfig,
    store,
    () => true, // isAlive
    () => true, // isVisible
    ['id'],
    'asc',
    100,
    1000,
  );
}

describe('lookupMemory — param resolution', () => {
  const records = [
    { id: 'c1', slug: 'test-room', tenantId: null, name: 'Single-tenant room' },
    { id: 'c2', slug: 'test-room', tenantId: 't-acme', name: 'Acme tenant' },
    { id: 'c3', slug: 'other-room', tenantId: null, name: 'Other' },
  ];

  it('omitted param acts as wildcard — finds first slug match across tenants', async () => {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
      returns: 'one',
    };
    const exec = mkExecutor(op, makeStore(records));
    // Call with only `slug` — `tenantId` omitted should drop the
    // constraint and return the first matching record.
    const result = (await exec({ slug: 'test-room' })) as { id?: string } | null;
    expect(result?.id).toBe('c1');
  });

  it('null param matches IS NULL records', async () => {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
      returns: 'one',
    };
    const exec = mkExecutor(op, makeStore(records));
    const result = (await exec({ slug: 'test-room', tenantId: null })) as { id?: string } | null;
    expect(result?.id).toBe('c1');
  });

  it('primitive param does exact match', async () => {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
      returns: 'one',
    };
    const exec = mkExecutor(op, makeStore(records));
    const result = (await exec({ slug: 'test-room', tenantId: 't-acme' })) as {
      id?: string;
    } | null;
    expect(result?.id).toBe('c2');
  });

  it('returns null when nothing matches', async () => {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
      returns: 'one',
    };
    const exec = mkExecutor(op, makeStore(records));
    const result = await exec({ slug: 'no-such-slug' });
    expect(result).toBeNull();
  });

  it('many — omitted param yields all rows for that field', async () => {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
      returns: 'many',
    };
    const exec = mkExecutor(op, makeStore(records));
    const result = (await exec({ slug: 'test-room' })) as { items: { id: string }[] };
    expect(result.items.map(r => r.id).sort()).toEqual(['c1', 'c2']);
  });
});

/**
 * `limit` semantics for `returns: 'many'`.
 *
 * The load-bearing case is the FIRST test: omitting `limit` must stay
 * unbounded. slingshot-community's `updateScore` re-lists every reaction on a
 * target to recompute `score` and `reactionSummary`, so a default page size
 * here would silently under-count scores on any target past that size — a
 * data-corruption bug wearing a safety net's clothes.
 */
describe('lookupMemory — limit', () => {
  const manyRecords = Array.from({ length: 25 }, (_, i) => ({
    id: `r${String(i).padStart(2, '0')}`,
    kind: 'reaction',
  }));

  function mkMany(store: Map<string, MemoryEntry>, defaultLimit: number, maxLimit: number) {
    const op: LookupOpConfig = {
      kind: 'lookup',
      fields: { kind: 'param:kind' },
      returns: 'many',
    };
    return lookupMemory(
      op,
      noopConfig,
      store,
      () => true,
      () => true,
      ['id'],
      'asc',
      defaultLimit,
      maxLimit,
    );
  }

  it('omitting limit does not bound the result below the backend default', async () => {
    const exec = mkMany(makeStore(manyRecords), 100, 1000);
    const result = (await exec({ kind: 'reaction' })) as { items: unknown[]; hasMore: boolean };
    expect(result.items).toHaveLength(25);
    expect(result.hasMore).toBe(false);
  });

  it('an explicit limit bounds the page and reports hasMore', async () => {
    const exec = mkMany(makeStore(manyRecords), 100, 1000);
    const result = (await exec({ kind: 'reaction', limit: 6 })) as {
      items: { id: string }[];
      hasMore: boolean;
    };
    expect(result.items).toHaveLength(6);
    expect(result.hasMore).toBe(true);
    expect(result.items[0]?.id).toBe('r00');
  });

  it('clamps an oversized limit to maxLimit', async () => {
    const exec = mkMany(makeStore(manyRecords), 100, 10);
    const result = (await exec({ kind: 'reaction', limit: 9999 })) as { items: unknown[] };
    expect(result.items).toHaveLength(10);
  });

  it('ignores a non-positive or unparseable limit rather than throwing', async () => {
    const exec = mkMany(makeStore(manyRecords), 100, 1000);
    for (const bad of [0, -5, Number.NaN, 'abc']) {
      const result = (await exec({ kind: 'reaction', limit: bad })) as { items: unknown[] };
      expect(result.items).toHaveLength(25);
    }
  });
});

/**
 * Edge-case tests for facet computation: single/multi-field distribution,
 * sorting, numeric stats, and edge inputs.
 */
import { describe, expect, test } from 'bun:test';
import { computeFacets } from '../../src/providers/facets';

describe('facet computation', () => {
  test('single field distribution', () => {
    const docs = [
      { status: 'published' },
      { status: 'draft' },
      { status: 'published' },
      { status: 'archived' },
    ];
    const { distribution } = computeFacets(docs, ['status']);
    expect(distribution.status).toEqual({
      published: 2,
      draft: 1,
      archived: 1,
    });
  });

  test('multi-field with two fields', () => {
    const docs = [
      { status: 'active', tier: 'premium' },
      { status: 'active', tier: 'basic' },
      { status: 'inactive', tier: 'premium' },
    ];
    const { distribution } = computeFacets(docs, ['status', 'tier']);
    expect(distribution.status).toEqual({ active: 2, inactive: 1 });
    expect(distribution.tier).toEqual({ premium: 2, basic: 1 });
  });

  test('handles missing values in some documents', () => {
    const docs = [
      { status: 'published', author: { country: 'US' } },
      { status: 'draft', author: null },
      { status: 'published', author: undefined },
    ];
    const { distribution } = computeFacets(docs, ['status', 'author.country']);
    expect(distribution.status).toEqual({ published: 2, draft: 1 });
    // Documents with null/undefined author.country are skipped
    expect(distribution['author.country']).toEqual({ US: 1 });
  });

  test('maxValues truncation caps the number of buckets', () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ category: `cat-${i}` }));
    const { distribution } = computeFacets(docs, ['category'], {
      category: { maxValues: 5 },
    });
    expect(Object.keys(distribution.category)).toHaveLength(5);
  });

  test('alpha sorting returns buckets in alphabetical order', () => {
    const docs = [
      { status: 'zebra' },
      { status: 'alpha' },
      { status: 'gamma' },
      { status: 'beta' },
    ];
    const { distribution } = computeFacets(docs, ['status'], {
      status: { sortBy: 'alpha' },
    });
    expect(Object.keys(distribution.status)).toEqual(['alpha', 'beta', 'gamma', 'zebra']);
  });

  test('count sorting returns buckets in descending count order', () => {
    const docs = [
      { status: 'common' },
      { status: 'common' },
      { status: 'common' },
      { status: 'rare' },
      { status: 'mid' },
      { status: 'mid' },
    ];
    const { distribution } = computeFacets(docs, ['status'], {
      status: { sortBy: 'count' },
    });
    const entries = Object.entries(distribution.status);
    // common=3, mid=2, rare=1 — descending
    expect(entries[0]).toEqual(['common', 3]);
    expect(entries[1]).toEqual(['mid', 2]);
    expect(entries[2]).toEqual(['rare', 1]);
  });

  test('numeric facet stats compute min/max/avg/sum/count', () => {
    const docs = [
      { score: 10 },
      { score: 20 },
      { score: 30 },
      { score: 40 },
    ];
    const { stats } = computeFacets(docs, ['score']);
    expect(stats.score).toBeDefined();
    expect(stats.score!.min).toBe(10);
    expect(stats.score!.max).toBe(40);
    expect(stats.score!.sum).toBe(100);
    expect(stats.score!.count).toBe(4);
    expect(stats.score!.avg).toBe(25);
  });

  test('non-numeric fields are absent from stats', () => {
    const docs = [
      { status: 'published', score: 5 },
      { status: 'draft', score: 3 },
    ];
    const { stats } = computeFacets(docs, ['status', 'score']);
    // status is a string — no stats entry
    expect(stats.status).toBeUndefined();
    // score is numeric — stats entry present
    expect(stats.score).toBeDefined();
  });

  test('empty documents array returns empty distribution and stats', () => {
    const { distribution, stats } = computeFacets([], ['status', 'score']);
    expect(distribution.status).toEqual({});
    expect(distribution.score).toEqual({});
    expect(stats).toEqual({});
  });

  test('nested field path extraction works', () => {
    const docs = [
      { author: { name: 'Alice', department: 'engineering' } },
      { author: { name: 'Bob', department: 'engineering' } },
      { author: { name: 'Charlie', department: 'marketing' } },
    ];
    const { distribution } = computeFacets(docs, ['author.department']);
    expect(distribution['author.department']).toEqual({
      engineering: 2,
      marketing: 1,
    });
  });
});

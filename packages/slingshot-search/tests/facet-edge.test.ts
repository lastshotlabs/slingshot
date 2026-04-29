/**
 * Edge-case tests for facet calculations: multi-select facets, hierarchical
 * facets, facet count accuracy, and numeric stats.
 */
import { describe, expect, test } from 'bun:test';
import { computeFacets } from '../src/providers/facets';

describe('facet calculations', () => {
  test('computes distribution for single field facets', () => {
    const docs = [
      { category: 'news', status: 'published', score: 10 },
      { category: 'tech', status: 'published', score: 20 },
      { category: 'news', status: 'draft', score: 15 },
      { category: 'sports', status: 'published', score: 30 },
    ];
    const result = computeFacets(docs, ['category']);
    expect(result.distribution.category).toEqual({
      news: 2,
      tech: 1,
      sports: 1,
    });
  });

  test('multi-select facets return counts for each value', () => {
    const docs = [
      { tags: 'a', status: 'active' },
      { tags: 'b', status: 'active' },
      { tags: 'a', status: 'inactive' },
      { tags: 'c', status: 'active' },
      { tags: 'a', status: 'active' },
    ];
    const result = computeFacets(docs, ['tags', 'status']);
    expect(result.distribution.tags).toEqual({ a: 3, b: 1, c: 1 });
    expect(result.distribution.status).toEqual({ active: 3, inactive: 1 });
  });

  test('facet with missing values in some docs counts only present values', () => {
    const docs = [
      { category: 'news' },
      { category: 'tech' },
      {},
      { category: 'news' },
    ];
    const result = computeFacets(docs, ['category']);
    expect(result.distribution.category).toEqual({ news: 2, tech: 1 });
  });

  test('facet with maxValues limit truncates less frequent values', () => {
    const docs = [
      { category: 'news' },
      { category: 'tech' },
      { category: 'sports' },
      { category: 'news' },
      { category: 'health' },
    ];
    const result = computeFacets(docs, ['category'], {
      category: { maxValues: 2, sortBy: 'count' },
    });
    // 'news' should be first (count=2), then one more
    const entries = Object.entries(result.distribution.category);
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(entries[0][0]).toBe('news');
  });

  test('alpha sorting of facet values', () => {
    const docs = [
      { category: 'zeta' },
      { category: 'alpha' },
      { category: 'beta' },
      { category: 'gamma' },
    ];
    const result = computeFacets(docs, ['category'], {
      category: { sortBy: 'alpha' },
    });
    const values = Object.keys(result.distribution.category);
    expect(values).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
  });

  test('count sorting of facet values puts most frequent first', () => {
    const docs = [
      { priority: 'low' },
      { priority: 'high' },
      { priority: 'high' },
      { priority: 'medium' },
      { priority: 'high' },
      { priority: 'medium' },
    ];
    const result = computeFacets(docs, ['priority'], {
      priority: { sortBy: 'count' },
    });
    const values = Object.keys(result.distribution.priority);
    // 'high' with count 3 should be first
    expect(values[0]).toBe('high');
  });

  test('numeric facets produce stats with min, max, avg, sum, count', () => {
    const docs = [
      { score: 10, rating: 4.5 },
      { score: 20, rating: 3.0 },
      { score: 30, rating: 5.0 },
      { score: 40, rating: 2.5 },
    ];
    const result = computeFacets(docs, ['score', 'rating']);
    expect(result.stats.score).toEqual({
      min: 10,
      max: 40,
      avg: 25,
      sum: 100,
      count: 4,
    });
    expect(result.stats.rating).toEqual({
      min: 2.5,
      max: 5.0,
      avg: 3.75,
      sum: 15.0,
      count: 4,
    });
  });

  test('returns empty distribution and stats when no facets requested', () => {
    const docs = [{ category: 'news', score: 10 }];
    const result = computeFacets(docs, []);
    expect(result).toEqual({ distribution: {}, stats: {} });
  });

  test('handles empty document list gracefully', () => {
    const result = computeFacets([], ['category']);
    expect(result.distribution).toEqual({ category: {} });
    expect(result.stats).toEqual({});
  });

  test('nested field path facet extraction works', () => {
    const docs = [
      { author: { country: 'US', role: 'admin' } },
      { author: { country: 'CA', role: 'user' } },
      { author: { country: 'US', role: 'user' } },
    ];
    const result = computeFacets(docs, ['author.country']);
    expect(result.distribution['author.country']).toEqual({ US: 2, CA: 1 });
  });
});

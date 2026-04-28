import { describe, expect, it } from 'bun:test';
import { FilterParseError, parseUrlFilter, parseUrlSort } from '../src/queryParser';

describe('search URL filter parser', () => {
  it('returns undefined for empty inputs', () => {
    expect(parseUrlFilter(undefined)).toBeUndefined();
    expect(parseUrlFilter('   ')).toBeUndefined();
  });

  it('parses scalar equality values with natural coercion', () => {
    expect(parseUrlFilter('status:published')).toEqual({
      field: 'status',
      op: '=',
      value: 'published',
    });
    expect(parseUrlFilter('published:true')).toEqual({ field: 'published', op: '=', value: true });
    expect(parseUrlFilter('archived:false')).toEqual({ field: 'archived', op: '=', value: false });
    expect(parseUrlFilter('deletedAt:null')).toEqual({ field: 'deletedAt', op: '=', value: null });
    expect(parseUrlFilter('score:42')).toEqual({ field: 'score', op: '=', value: 42 });
  });

  it('parses keyword, function, comparison, and multi-condition filters', () => {
    expect(parseUrlFilter('status:exists')).toEqual({ field: 'status', op: 'EXISTS', value: null });
    expect(parseUrlFilter('status:empty')).toEqual({
      field: 'status',
      op: 'IS_EMPTY',
      value: null,
    });
    expect(parseUrlFilter('status:!exists')).toEqual({
      field: 'status',
      op: 'NOT_EXISTS',
      value: null,
    });
    expect(parseUrlFilter('status:!empty')).toEqual({
      field: 'status',
      op: 'IS_NOT_EMPTY',
      value: null,
    });
    expect(parseUrlFilter('status:!=draft')).toEqual({ field: 'status', op: '!=', value: 'draft' });
    expect(parseUrlFilter('score:>=10')).toEqual({ field: 'score', op: '>=', value: 10 });
    expect(parseUrlFilter('score:<=20')).toEqual({ field: 'score', op: '<=', value: 20 });
    expect(parseUrlFilter('score:>1')).toEqual({ field: 'score', op: '>', value: 1 });
    expect(parseUrlFilter('score:<9')).toEqual({ field: 'score', op: '<', value: 9 });
    expect(parseUrlFilter('status:in(published,"draft,review",true)')).toEqual({
      field: 'status',
      op: 'IN',
      value: ['published', 'draft,review', true],
    });
    expect(parseUrlFilter("status:!in('draft',archived)")).toEqual({
      field: 'status',
      op: 'NOT_IN',
      value: ['draft', 'archived'],
    });
    expect(parseUrlFilter('score:between(1,10)')).toEqual({
      field: 'score',
      op: 'BETWEEN',
      value: [1, 10],
    });
    expect(parseUrlFilter('title:starts_with(Al)')).toEqual({
      field: 'title',
      op: 'STARTS_WITH',
      value: 'Al',
    });
    expect(parseUrlFilter('title:contains(42)')).toEqual({
      field: 'title',
      op: 'CONTAINS',
      value: 42,
    });
    expect(parseUrlFilter('status:published,score:>=10,tags:in(a,b)')).toEqual({
      $and: [
        { field: 'status', op: '=', value: 'published' },
        { field: 'score', op: '>=', value: 10 },
        { field: 'tags', op: 'IN', value: ['a', 'b'] },
      ],
    });
  });

  it('throws FilterParseError for malformed filters and numeric operator misuse', () => {
    const cases = [
      'status',
      ':published',
      'status:',
      'score:between(1)',
      'score:between(one,two)',
      'score:>=ten',
      'score:<=ten',
      'score:>ten',
      'score:<ten',
    ];

    for (const filter of cases) {
      expect(() => parseUrlFilter(filter)).toThrow(FilterParseError);
    }

    try {
      parseUrlFilter('score:>=ten');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterParseError);
      expect((err as FilterParseError).filterString).toBe('score:>=ten');
      expect((err as FilterParseError).position).toBeUndefined();
    }
  });
});

describe('search URL sort parser', () => {
  it('returns undefined for empty inputs and defaults unknown directions to asc', () => {
    expect(parseUrlSort(undefined)).toBeUndefined();
    expect(parseUrlSort(' ')).toBeUndefined();
    expect(parseUrlSort('score:desc,createdAt:asc,title:other,name')).toEqual([
      { field: 'score', direction: 'desc' },
      { field: 'createdAt', direction: 'asc' },
      { field: 'title', direction: 'asc' },
      { field: 'name', direction: 'asc' },
    ]);
  });
});

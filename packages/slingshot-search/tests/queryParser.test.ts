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

  // ── Edge cases for parseUrlFilter ──────────────────────────────────────────

  it('handles dotted field names', () => {
    expect(parseUrlFilter('meta.status:published')).toEqual({
      field: 'meta.status',
      op: '=',
      value: 'published',
    });
    expect(parseUrlFilter('user.address.city:NYC')).toEqual({
      field: 'user.address.city',
      op: '=',
      value: 'NYC',
    });
  });

  it('handles negative numbers in comparisons and between', () => {
    expect(parseUrlFilter('score:>=-5')).toEqual({ field: 'score', op: '>=', value: -5 });
    expect(parseUrlFilter('score:<=-10')).toEqual({ field: 'score', op: '<=', value: -10 });
    expect(parseUrlFilter('score:>-3')).toEqual({ field: 'score', op: '>', value: -3 });
    expect(parseUrlFilter('score:<-7')).toEqual({ field: 'score', op: '<', value: -7 });
    expect(parseUrlFilter('score:between(-10,10)')).toEqual({
      field: 'score',
      op: 'BETWEEN',
      value: [-10, 10],
    });
  });

  it('handles in() and !in() with mixed value types including negatives', () => {
    expect(parseUrlFilter('count:in(-1,0,1,42)')).toEqual({
      field: 'count',
      op: 'IN',
      value: [-1, 0, 1, 42],
    });
    expect(parseUrlFilter('type:!in(null,true,false)')).toEqual({
      field: 'type',
      op: 'NOT_IN',
      value: [null, true, false],
    });
  });

  it('handles nested parentheses in arg lists', () => {
    expect(parseUrlFilter('field:in(fn(a,b),c)')).toEqual({
      field: 'field',
      op: 'IN',
      value: ['fn(a,b)', 'c'],
    });
  });

  it('handles quoted strings in arg lists including commas inside quotes', () => {
    expect(parseUrlFilter("tags:in('hello world',x)")).toEqual({
      field: 'tags',
      op: 'IN',
      value: ['hello world', 'x'],
    });
    expect(parseUrlFilter('tags:in("a,b",c)')).toEqual({
      field: 'tags',
      op: 'IN',
      value: ['a,b', 'c'],
    });
  });

  it('handles starts_with with quoted values', () => {
    expect(parseUrlFilter("name:starts_with('Mc')")).toEqual({
      field: 'name',
      op: 'STARTS_WITH',
      value: "'Mc'",
    });
  });

  it('handles contains with string and null values', () => {
    expect(parseUrlFilter('desc:contains(hello)')).toEqual({
      field: 'desc',
      op: 'CONTAINS',
      value: 'hello',
    });
    expect(parseUrlFilter('field:contains(null)')).toEqual({
      field: 'field',
      op: 'CONTAINS',
      value: null,
    });
  });

  it('strips empty tokens between commas', () => {
    expect(parseUrlFilter('status:published,,score:>=10')).toEqual({
      $and: [
        { field: 'status', op: '=', value: 'published' },
        { field: 'score', op: '>=', value: 10 },
      ],
    });
  });

  it('treats leading/trailing commas gracefully', () => {
    expect(parseUrlFilter(',status:published,')).toEqual({
      field: 'status',
      op: '=',
      value: 'published',
    });
    expect(parseUrlFilter(',,status:published,,')).toEqual({
      field: 'status',
      op: '=',
      value: 'published',
    });
  });

  it('treats comma-only input as undefined', () => {
    expect(parseUrlFilter(',')).toBeUndefined();
    expect(parseUrlFilter(',,,')).toBeUndefined();
  });

  it('handles != with numeric coercion', () => {
    expect(parseUrlFilter('score:!=0')).toEqual({ field: 'score', op: '!=', value: 0 });
    expect(parseUrlFilter('score:!=-1')).toEqual({ field: 'score', op: '!=', value: -1 });
  });

  it('handles equality coercion edge cases', () => {
    // Empty expression after colon throws
    expect(() => parseUrlFilter('field:')).toThrow(FilterParseError);
    // Whitespace values are preserved
    expect(parseUrlFilter('field:  leading')).toEqual({
      field: 'field',
      op: '=',
      value: '  leading',
    });
  });

  it('returns bare condition for single token', () => {
    expect(parseUrlFilter('x:1')).toEqual({ field: 'x', op: '=', value: 1 });
  });

  it('FilterParseError captures filterString for caller diagnostics', () => {
    try {
      parseUrlFilter('bad');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterParseError);
      expect((err as FilterParseError).filterString).toBe('bad');
      expect((err as FilterParseError).name).toBe('FilterParseError');
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

  it('handles trailing commas and whitespace-only tokens', () => {
    expect(parseUrlSort('score:desc,')).toEqual([{ field: 'score', direction: 'desc' }]);
    expect(parseUrlSort(',score:desc')).toEqual([{ field: 'score', direction: 'desc' }]);
  });

  it('preserves field names with colons inside them', () => {
    expect(parseUrlSort('_geo:desc')).toEqual([{ field: '_geo', direction: 'desc' }]);
  });
});

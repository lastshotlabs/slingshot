/**
 * Edge-case tests for the Algolia provider: filter translation, settings
 * mapping, and facet parameter handling.
 *
 * These tests exercise the pure translation functions without needing HTTP.
 */
import { describe, expect, test } from 'bun:test';
import { searchFilterToAlgoliaFilter } from '../../src/providers/algolia';
import type { SearchFilter } from '../../src/types/query';

describe('Algolia — filter translation', () => {
  test('translates simple equality filter', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'status',
      op: '=',
      value: 'published',
    });
    expect(result).toBe('status:"published"');
  });

  test('translates numeric comparison filters', () => {
    expect(
      searchFilterToAlgoliaFilter({ field: 'price', op: '>', value: 100 }),
    ).toBe('price > 100');
    expect(
      searchFilterToAlgoliaFilter({ field: 'price', op: '>=', value: 10 }),
    ).toBe('price >= 10');
    expect(
      searchFilterToAlgoliaFilter({ field: 'price', op: '<', value: 50 }),
    ).toBe('price < 50');
    expect(
      searchFilterToAlgoliaFilter({ field: 'price', op: '<=', value: 200 }),
    ).toBe('price <= 200');
  });

  test('translates IN filter as OR conditions', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'category',
      op: 'IN',
      value: ['news', 'tech'],
    });
    expect(result).toBe('(category:"news" OR category:"tech")');
  });

  test('translates NOT_IN filter as AND NOT conditions', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'status',
      op: 'NOT_IN',
      value: ['deleted', 'archived'],
    });
    expect(result).toBe('(NOT status:"deleted" AND NOT status:"archived")');
  });

  test('translates BETWEEN filter', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'price',
      op: 'BETWEEN',
      value: [10, 100],
    });
    expect(result).toBe('price:10 TO 100');
  });

  test('translates $and composite filter', () => {
    const filter: SearchFilter = {
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'price', op: '>=', value: 10 },
      ],
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(status:"active") AND (price >= 10)');
  });

  test('translates $or composite filter', () => {
    const filter: SearchFilter = {
      $or: [
        { field: 'status', op: '=', value: 'draft' },
        { field: 'visibility', op: '=', value: 'public' },
      ],
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(status:"draft") OR (visibility:"public")');
  });

  test('translates $not filter', () => {
    const filter: SearchFilter = {
      $not: { field: 'status', op: '=', value: 'deleted' },
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('NOT (status:"deleted")');
  });

  test('translates EXISTS and NOT_EXISTS', () => {
    expect(
      searchFilterToAlgoliaFilter({ field: 'email', op: 'EXISTS', value: null }),
    ).toBe('email:*');
    expect(
      searchFilterToAlgoliaFilter({ field: 'email', op: 'NOT_EXISTS', value: null }),
    ).toBe('NOT email:*');
  });

  test('string escaping with double quotes inside values', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'name',
      op: '=',
      value: 'hello"world',
    });
    expect(result).toBe('name:"hello\\"world"');
  });

  test('translates $geoRadius filter', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1000 },
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('aroundLatLng:48.85,2.35,aroundRadius:1000');
  });

  test('translates $geoBoundingBox filter', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 48.9, lng: 2.3 },
        bottomRight: { lat: 48.8, lng: 2.4 },
      },
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('insideBoundingBox:48.9,2.3,48.8,2.4');
  });

  test('STARTS_WITH falls back to equality with warning', () => {
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnCalls.push(msg);

    try {
      const result = searchFilterToAlgoliaFilter({
        field: 'title',
        op: 'STARTS_WITH',
        value: 'start',
      });
      expect(result).toBe('title:"start"');
      expect(warnCalls.some(w => w.includes('STARTS_WITH'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('Algolia — IS_EMPTY / IS_NOT_EMPTY', () => {
  test('IS_EMPTY translates to NOT field:*', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'description',
      op: 'IS_EMPTY',
      value: null,
    });
    expect(result).toBe('NOT description:*');
  });

  test('IS_NOT_EMPTY translates to field:*', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'description',
      op: 'IS_NOT_EMPTY',
      value: null,
    });
    expect(result).toBe('description:*');
  });
});

describe('Algolia — != filter', () => {
  test('translates != operator', () => {
    const result = searchFilterToAlgoliaFilter({
      field: 'status',
      op: '!=',
      value: 'deleted',
    });
    expect(result).toBe('NOT status:"deleted"');
  });
});

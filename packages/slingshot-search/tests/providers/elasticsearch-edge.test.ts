/**
 * Edge-case tests for the Elasticsearch provider: filter query DSL translation,
 * mapping generation, and sort translation.
 */
import { describe, expect, test } from 'bun:test';
import { searchFilterToElasticsearchQuery } from '../../src/providers/elasticsearch';
import type { SearchFilter } from '../../src/types/query';

describe('Elasticsearch — filter to query DSL translation', () => {
  test('translates equality to term query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'status',
      op: '=',
      value: 'published',
    });
    expect(result).toEqual({ term: { status: 'published' } });
  });

  test('translates != to bool must_not term', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'status',
      op: '!=',
      value: 'deleted',
    });
    expect(result).toEqual({
      bool: { must_not: [{ term: { status: 'deleted' } }] },
    });
  });

  test('translates numeric comparisons to range queries', () => {
    expect(searchFilterToElasticsearchQuery({ field: 'price', op: '>', value: 100 })).toEqual({
      range: { price: { gt: 100 } },
    });
    expect(searchFilterToElasticsearchQuery({ field: 'price', op: '>=', value: 10 })).toEqual({
      range: { price: { gte: 10 } },
    });
    expect(searchFilterToElasticsearchQuery({ field: 'price', op: '<', value: 50 })).toEqual({
      range: { price: { lt: 50 } },
    });
    expect(searchFilterToElasticsearchQuery({ field: 'price', op: '<=', value: 200 })).toEqual({
      range: { price: { lte: 200 } },
    });
  });

  test('translates IN to terms query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'category',
      op: 'IN',
      value: ['news', 'tech'],
    });
    expect(result).toEqual({ terms: { category: ['news', 'tech'] } });
  });

  test('translates NOT_IN to bool must_not terms', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'status',
      op: 'NOT_IN',
      value: ['deleted', 'archived'],
    });
    expect(result).toEqual({
      bool: { must_not: [{ terms: { status: ['deleted', 'archived'] } }] },
    });
  });

  test('translates EXISTS query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'email',
      op: 'EXISTS',
      value: null,
    });
    expect(result).toEqual({ exists: { field: 'email' } });
  });

  test('translates NOT_EXISTS query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'email',
      op: 'NOT_EXISTS',
      value: null,
    });
    expect(result).toEqual({
      bool: { must_not: [{ exists: { field: 'email' } }] },
    });
  });

  test('translates BETWEEN to range with gte/lte', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'price',
      op: 'BETWEEN',
      value: [10, 100],
    });
    expect(result).toEqual({ range: { price: { gte: 10, lte: 100 } } });
  });

  test('translates CONTAINS to match query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'title',
      op: 'CONTAINS',
      value: 'hello',
    });
    expect(result).toEqual({ match: { title: 'hello' } });
  });

  test('translates STARTS_WITH to prefix query', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'title',
      op: 'STARTS_WITH',
      value: 'prefix',
    });
    expect(result).toEqual({ prefix: { title: 'prefix' } });
  });
});

describe('Elasticsearch — composite filter translation', () => {
  test('translates $and to bool.filter', () => {
    const filter: SearchFilter = {
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'price', op: '>=', value: 10 },
      ],
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: {
        filter: [{ term: { status: 'active' } }, { range: { price: { gte: 10 } } }],
      },
    });
  });

  test('translates $or to bool.should with minimum_should_match', () => {
    const filter: SearchFilter = {
      $or: [
        { field: 'status', op: '=', value: 'draft' },
        { field: 'status', op: '=', value: 'archived' },
      ],
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: {
        should: [{ term: { status: 'draft' } }, { term: { status: 'archived' } }],
        minimum_should_match: 1,
      },
    });
  });

  test('translates $not to bool.must_not', () => {
    const filter: SearchFilter = {
      $not: { field: 'status', op: '=', value: 'deleted' },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: {
        must_not: [{ term: { status: 'deleted' } }],
      },
    });
  });
});

describe('Elasticsearch — geo query translation', () => {
  test('translates $geoRadius to geo_distance query', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1000 },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_distance: {
        distance: '1000m',
        _geo: { lat: 48.85, lon: 2.35 },
      },
    });
  });

  test('translates $geoBoundingBox to geo_bounding_box query', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 48.9, lng: 2.3 },
        bottomRight: { lat: 48.8, lng: 2.4 },
      },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_bounding_box: {
        _geo: {
          top_left: { lat: 48.9, lon: 2.3 },
          bottom_right: { lat: 48.8, lon: 2.4 },
        },
      },
    });
  });
});

describe('Elasticsearch — IS_EMPTY / IS_NOT_EMPTY', () => {
  test('IS_EMPTY translates to bool.should with term empty or must_not exists', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'description',
      op: 'IS_EMPTY',
      value: null,
    });
    expect(result).toEqual({
      bool: {
        should: [
          { term: { description: '' } },
          { bool: { must_not: [{ exists: { field: 'description' } }] } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  test('IS_NOT_EMPTY translates to bool must exists AND must_not term empty', () => {
    const result = searchFilterToElasticsearchQuery({
      field: 'description',
      op: 'IS_NOT_EMPTY',
      value: null,
    });
    expect(result).toEqual({
      bool: {
        must: [{ exists: { field: 'description' } }],
        must_not: [{ term: { description: '' } }],
      },
    });
  });
});

describe('Elasticsearch — Date value handling', () => {
  test('Date values are serialized to ISO strings', () => {
    const date = new Date('2026-04-19T12:00:00.000Z');
    const result = searchFilterToElasticsearchQuery({
      field: 'createdAt',
      op: '>',
      value: date,
    });
    expect(result).toEqual({ range: { createdAt: { gt: '2026-04-19T12:00:00.000Z' } } });
  });
});

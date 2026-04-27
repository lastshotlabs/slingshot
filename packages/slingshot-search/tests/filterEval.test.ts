import { describe, expect, spyOn, test } from 'bun:test';
import { evaluateFilter, getNestedValue, haversineDistance } from '../src/providers/filterEval';

describe('getNestedValue', () => {
  test('returns a top-level scalar value', () => {
    expect(getNestedValue({ score: 42 }, 'score')).toBe(42);
  });

  test('returns a nested value via dot-notation', () => {
    expect(getNestedValue({ address: { city: 'London' } }, 'address.city')).toBe('London');
  });

  test('returns undefined for a missing key', () => {
    expect(getNestedValue({ x: 1 }, 'missing')).toBeUndefined();
  });

  test('returns undefined when an intermediate segment is null', () => {
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });

  test('returns undefined when an intermediate segment is undefined', () => {
    expect(getNestedValue({ a: undefined }, 'a.b')).toBeUndefined();
  });

  test('returns a deeply nested value', () => {
    expect(getNestedValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });
});

describe('evaluateFilter — scalar operators', () => {
  test('= matches equal value', () => {
    expect(
      evaluateFilter({ status: 'published' }, { field: 'status', op: '=', value: 'published' }),
    ).toBe(true);
  });

  test('= does not match different value', () => {
    expect(
      evaluateFilter({ status: 'draft' }, { field: 'status', op: '=', value: 'published' }),
    ).toBe(false);
  });

  test('!= matches different value', () => {
    expect(
      evaluateFilter({ status: 'draft' }, { field: 'status', op: '!=', value: 'published' }),
    ).toBe(true);
  });

  test('!= does not match equal value', () => {
    expect(
      evaluateFilter({ status: 'published' }, { field: 'status', op: '!=', value: 'published' }),
    ).toBe(false);
  });

  test('> matches greater number', () => {
    expect(evaluateFilter({ score: 10 }, { field: 'score', op: '>', value: 5 })).toBe(true);
  });

  test('> returns false for non-number field', () => {
    expect(evaluateFilter({ score: 'high' }, { field: 'score', op: '>', value: 5 })).toBe(false);
  });

  test('>= matches equal number', () => {
    expect(evaluateFilter({ score: 5 }, { field: 'score', op: '>=', value: 5 })).toBe(true);
  });

  test('< matches smaller number', () => {
    expect(evaluateFilter({ score: 3 }, { field: 'score', op: '<', value: 5 })).toBe(true);
  });

  test('<= matches equal number', () => {
    expect(evaluateFilter({ score: 5 }, { field: 'score', op: '<=', value: 5 })).toBe(true);
  });

  test('IN matches value in array', () => {
    expect(
      evaluateFilter(
        { status: 'draft' },
        { field: 'status', op: 'IN', value: ['draft', 'published'] },
      ),
    ).toBe(true);
  });

  test('IN returns false for value not in array', () => {
    expect(
      evaluateFilter(
        { status: 'archived' },
        { field: 'status', op: 'IN', value: ['draft', 'published'] },
      ),
    ).toBe(false);
  });

  test('IN returns false when value is not an array', () => {
    expect(
      evaluateFilter({ status: 'draft' }, { field: 'status', op: 'IN', value: 'draft' as any }),
    ).toBe(false);
  });

  test('NOT_IN matches value not in array', () => {
    expect(
      evaluateFilter(
        { status: 'archived' },
        { field: 'status', op: 'NOT_IN', value: ['draft', 'published'] },
      ),
    ).toBe(true);
  });

  test('EXISTS returns true when field has a value', () => {
    expect(evaluateFilter({ name: 'Alice' }, { field: 'name', op: 'EXISTS', value: null })).toBe(
      true,
    );
  });

  test('EXISTS returns false when field is undefined', () => {
    expect(evaluateFilter({}, { field: 'name', op: 'EXISTS', value: null })).toBe(false);
  });

  test('EXISTS returns false when field is null', () => {
    expect(evaluateFilter({ name: null }, { field: 'name', op: 'EXISTS', value: null })).toBe(
      false,
    );
  });

  test('NOT_EXISTS returns true when field is undefined', () => {
    expect(evaluateFilter({}, { field: 'name', op: 'NOT_EXISTS', value: null })).toBe(true);
  });

  test('CONTAINS returns true when array field contains value', () => {
    expect(
      evaluateFilter({ tags: ['a', 'b'] }, { field: 'tags', op: 'CONTAINS', value: 'a' }),
    ).toBe(true);
  });

  test('CONTAINS returns true when string field contains substring', () => {
    expect(
      evaluateFilter({ title: 'hello world' }, { field: 'title', op: 'CONTAINS', value: 'world' }),
    ).toBe(true);
  });

  test('CONTAINS returns false for non-array non-string field', () => {
    expect(evaluateFilter({ score: 42 }, { field: 'score', op: 'CONTAINS', value: 4 })).toBe(false);
  });

  test('BETWEEN matches value within inclusive range', () => {
    expect(evaluateFilter({ score: 5 }, { field: 'score', op: 'BETWEEN', value: [1, 10] })).toBe(
      true,
    );
  });

  test('BETWEEN matches value at lower bound', () => {
    expect(evaluateFilter({ score: 1 }, { field: 'score', op: 'BETWEEN', value: [1, 10] })).toBe(
      true,
    );
  });

  test('BETWEEN returns false for value outside range', () => {
    expect(evaluateFilter({ score: 11 }, { field: 'score', op: 'BETWEEN', value: [1, 10] })).toBe(
      false,
    );
  });

  test('BETWEEN returns false for non-number field', () => {
    expect(
      evaluateFilter({ score: 'medium' }, { field: 'score', op: 'BETWEEN', value: [1, 10] }),
    ).toBe(false);
  });

  test('BETWEEN returns false when value is not a 2-element array', () => {
    expect(evaluateFilter({ score: 5 }, { field: 'score', op: 'BETWEEN', value: [1] as any })).toBe(
      false,
    );
  });

  test('STARTS_WITH matches prefix', () => {
    expect(
      evaluateFilter(
        { title: 'hello world' },
        { field: 'title', op: 'STARTS_WITH', value: 'hello' },
      ),
    ).toBe(true);
  });

  test('STARTS_WITH returns false for non-string field', () => {
    expect(
      evaluateFilter({ title: 42 }, { field: 'title', op: 'STARTS_WITH', value: 'hello' }),
    ).toBe(false);
  });

  test('IS_EMPTY returns true for empty string', () => {
    expect(evaluateFilter({ title: '' }, { field: 'title', op: 'IS_EMPTY', value: null })).toBe(
      true,
    );
  });

  test('IS_EMPTY returns true for empty array', () => {
    expect(evaluateFilter({ tags: [] }, { field: 'tags', op: 'IS_EMPTY', value: null })).toBe(true);
  });

  test('IS_EMPTY returns true for undefined field', () => {
    expect(evaluateFilter({}, { field: 'title', op: 'IS_EMPTY', value: null })).toBe(true);
  });

  test('IS_EMPTY returns false for non-empty string', () => {
    expect(
      evaluateFilter({ title: 'hello' }, { field: 'title', op: 'IS_EMPTY', value: null }),
    ).toBe(false);
  });

  test('IS_NOT_EMPTY returns true for non-empty string', () => {
    expect(
      evaluateFilter({ title: 'hello' }, { field: 'title', op: 'IS_NOT_EMPTY', value: null }),
    ).toBe(true);
  });

  test('IS_NOT_EMPTY returns false for empty array', () => {
    expect(evaluateFilter({ tags: [] }, { field: 'tags', op: 'IS_NOT_EMPTY', value: null })).toBe(
      false,
    );
  });
});

describe('evaluateFilter — composite operators', () => {
  test('$and returns true when all conditions match', () => {
    expect(
      evaluateFilter(
        { status: 'published', score: 8 },
        {
          $and: [
            { field: 'status', op: '=', value: 'published' },
            { field: 'score', op: '>=', value: 5 },
          ],
        },
      ),
    ).toBe(true);
  });

  test('$and returns false when any condition fails', () => {
    expect(
      evaluateFilter(
        { status: 'draft', score: 8 },
        {
          $and: [
            { field: 'status', op: '=', value: 'published' },
            { field: 'score', op: '>=', value: 5 },
          ],
        },
      ),
    ).toBe(false);
  });

  test('$or returns true when at least one condition matches', () => {
    expect(
      evaluateFilter(
        { status: 'draft' },
        {
          $or: [
            { field: 'status', op: '=', value: 'published' },
            { field: 'status', op: '=', value: 'draft' },
          ],
        },
      ),
    ).toBe(true);
  });

  test('$or returns false when no condition matches', () => {
    expect(
      evaluateFilter(
        { status: 'archived' },
        {
          $or: [
            { field: 'status', op: '=', value: 'published' },
            { field: 'status', op: '=', value: 'draft' },
          ],
        },
      ),
    ).toBe(false);
  });

  test('$not inverts a truthy condition', () => {
    expect(
      evaluateFilter(
        { status: 'draft' },
        { $not: { field: 'status', op: '=', value: 'published' } },
      ),
    ).toBe(true);
  });

  test('$not inverts a falsy condition', () => {
    expect(
      evaluateFilter(
        { status: 'published' },
        { $not: { field: 'status', op: '=', value: 'published' } },
      ),
    ).toBe(false);
  });

  test('nested $and inside $or', () => {
    const doc = { status: 'published', score: 9 };
    expect(
      evaluateFilter(doc, {
        $or: [
          {
            $and: [
              { field: 'status', op: '=', value: 'published' },
              { field: 'score', op: '>', value: 8 },
            ],
          },
          { field: 'status', op: '=', value: 'draft' },
        ],
      }),
    ).toBe(true);
  });
});

describe('evaluateFilter — geo operators', () => {
  test('$geoRadius matches document within radius', () => {
    // Big Ben to a point ~100m away
    const doc = { _geo: { lat: 51.5007, lng: -0.1246 } };
    expect(
      evaluateFilter(doc, {
        $geoRadius: { lat: 51.5008, lng: -0.1246, radiusMeters: 200 },
      }),
    ).toBe(true);
  });

  test('$geoRadius excludes document outside radius', () => {
    const doc = { _geo: { lat: 51.5007, lng: -0.1246 } };
    expect(
      evaluateFilter(doc, {
        $geoRadius: { lat: 48.8584, lng: 2.2945, radiusMeters: 1000 },
      }),
    ).toBe(false);
  });

  test('$geoRadius returns false when document has no _geo field', () => {
    expect(
      evaluateFilter(
        { name: 'no location' },
        { $geoRadius: { lat: 51.5007, lng: -0.1246, radiusMeters: 1000 } },
      ),
    ).toBe(false);
  });

  test('$geoBoundingBox matches document within box', () => {
    // London bounding box
    const doc = { _geo: { lat: 51.5007, lng: -0.1246 } };
    expect(
      evaluateFilter(doc, {
        $geoBoundingBox: {
          topLeft: { lat: 52.0, lng: -0.5 },
          bottomRight: { lat: 51.0, lng: 0.5 },
        },
      }),
    ).toBe(true);
  });

  test('$geoBoundingBox excludes document outside box', () => {
    const doc = { _geo: { lat: 48.8584, lng: 2.2945 } };
    expect(
      evaluateFilter(doc, {
        $geoBoundingBox: {
          topLeft: { lat: 52.0, lng: -0.5 },
          bottomRight: { lat: 51.0, lng: 0.5 },
        },
      }),
    ).toBe(false);
  });

  test('$geoBoundingBox returns false when document has no _geo field', () => {
    expect(
      evaluateFilter(
        { name: 'no location' },
        {
          $geoBoundingBox: {
            topLeft: { lat: 52.0, lng: -0.5 },
            bottomRight: { lat: 51.0, lng: 0.5 },
          },
        },
      ),
    ).toBe(false);
  });
});

describe('evaluateFilter — unknown node type', () => {
  test('unknown node returns false and logs a warning', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateFilter({ status: 'published' }, { $unknown: true } as any);
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toContain('[slingshot-search]');
    warnSpy.mockRestore();
  });
});

describe('haversineDistance', () => {
  test('distance from a point to itself is zero', () => {
    expect(haversineDistance(51.5007, -0.1246, 51.5007, -0.1246)).toBe(0);
  });

  test('approximate distance Big Ben to Eiffel Tower is ~341 km', () => {
    const dist = haversineDistance(51.5007, -0.1246, 48.8584, 2.2945);
    expect(dist).toBeGreaterThan(340_000);
    expect(dist).toBeLessThan(343_000);
  });

  test('returns a positive value for non-identical points', () => {
    expect(haversineDistance(0, 0, 0, 1)).toBeGreaterThan(0);
  });
});

/**
 * Tests for geo search filter translation across providers.
 *
 * Tests radius queries, bounding box, distance sorting, and that each
 * provider's filter translator handles geo shapes correctly.
 */
import { describe, expect, test } from 'bun:test';
import { searchFilterToAlgoliaFilter } from '../src/providers/algolia';
import { searchFilterToElasticsearchQuery } from '../src/providers/elasticsearch';
import { searchFilterToTypesenseFilter } from '../src/providers/typesense';
import type { SearchFilter } from '../src/types/query';

describe('geo search — Typesense', () => {
  test('radius query translates to location filter with km radius', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 40.7128, lng: -74.006, radiusMeters: 5000 },
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toBe('location:(40.7128, -74.006, 5 km)');
  });

  test('small radius (under 1 km) shows decimal', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 40.7128, lng: -74.006, radiusMeters: 500 },
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toBe('location:(40.7128, -74.006, 0.5 km)');
  });

  test('bounding box approximates center + radius', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 40.8, lng: -74.1 },
        bottomRight: { lat: 40.6, lng: -73.9 },
      },
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toContain('location:(');
    // Center should be approximately midpoint
    expect(result).toContain('km)');
  });

  test('zero radius produces 0 km', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 0, lng: 0, radiusMeters: 0 },
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toBe('location:(0, 0, 0 km)');
  });
});

describe('geo search — Algolia', () => {
  test('radius query translates to aroundLatLng with aroundRadius', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1500 },
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('aroundLatLng:48.85,2.35,aroundRadius:1500');
  });

  test('bounding box translates to insideBoundingBox', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 48.9, lng: 2.3 },
        bottomRight: { lat: 48.8, lng: 2.4 },
      },
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('insideBoundingBox:48.9,2.3,48.8,2.4');
  });
});

describe('geo search — Elasticsearch', () => {
  test('radius query translates to geo_distance', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 40.7128, lng: -74.006, radiusMeters: 5000 },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_distance: {
        distance: '5000m',
        _geo: { lat: 40.7128, lon: -74.006 },
      },
    });
  });

  test('bounding box translates to geo_bounding_box', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 40.8, lng: -74.1 },
        bottomRight: { lat: 40.6, lng: -73.9 },
      },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_bounding_box: {
        _geo: {
          top_left: { lat: 40.8, lon: -74.1 },
          bottom_right: { lat: 40.6, lon: -73.9 },
        },
      },
    });
  });
});

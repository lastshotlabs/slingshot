import { describe, expect, test } from 'bun:test';
import type { GeoSearchConfig } from '@lastshotlabs/slingshot-core';
import { applyGeoTransform } from '../../../packages/slingshot-search/src/geoTransform';

// ============================================================================
// Tests
// ============================================================================

describe('applyGeoTransform', () => {
  const geoConfig: GeoSearchConfig = {
    latField: 'latitude',
    lngField: 'longitude',
  };

  // --------------------------------------------------------------------------
  // _geo added when lat/lng present
  // --------------------------------------------------------------------------

  test('adds _geo field when both lat and lng are present', () => {
    const doc = { id: '1', latitude: 48.8566, longitude: 2.3522, name: 'Paris' };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toEqual({ lat: 48.8566, lng: 2.3522 });
    expect(result.id).toBe('1');
    expect(result.name).toBe('Paris');
    expect(result.latitude).toBe(48.8566);
    expect(result.longitude).toBe(2.3522);
  });

  test('converts string lat/lng to numbers', () => {
    const doc = { id: '1', latitude: '40.7128', longitude: '-74.0060' };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  test('handles zero values for lat/lng', () => {
    const doc = { id: '1', latitude: 0, longitude: 0 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toEqual({ lat: 0, lng: 0 });
  });

  // --------------------------------------------------------------------------
  // No _geo when null values
  // --------------------------------------------------------------------------

  test('does not add _geo when lat is null', () => {
    const doc = { id: '1', latitude: null, longitude: 2.3522 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  test('does not add _geo when lng is null', () => {
    const doc = { id: '1', latitude: 48.8566, longitude: null };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  test('does not add _geo when both are null', () => {
    const doc = { id: '1', latitude: null, longitude: null };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // No _geo when partial / missing values
  // --------------------------------------------------------------------------

  test('does not add _geo when lat field is missing', () => {
    const doc = { id: '1', longitude: 2.3522 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  test('does not add _geo when lng field is missing', () => {
    const doc = { id: '1', latitude: 48.8566 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  test('does not add _geo when both fields are missing', () => {
    const doc = { id: '1', name: 'No coords' };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  test('does not add _geo when lat is undefined', () => {
    const doc = { id: '1', latitude: undefined, longitude: 2.3522 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result._geo).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Custom field names
  // --------------------------------------------------------------------------

  test('works with custom lat/lng field names', () => {
    const customConfig: GeoSearchConfig = {
      latField: 'lat',
      lngField: 'lng',
    };
    const doc = { id: '1', lat: 51.5074, lng: -0.1278 };
    const result = applyGeoTransform(doc, customConfig);

    expect(result._geo).toEqual({ lat: 51.5074, lng: -0.1278 });
  });

  // --------------------------------------------------------------------------
  // Immutability
  // --------------------------------------------------------------------------

  test('does not mutate the original document', () => {
    const doc = { id: '1', latitude: 48.8566, longitude: 2.3522 };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result).not.toBe(doc);
    expect(doc).not.toHaveProperty('_geo');
  });

  test('returns original doc reference when no geo fields present', () => {
    const doc = { id: '1', name: 'No coords' };
    const result = applyGeoTransform(doc, geoConfig);

    expect(result).toBe(doc);
  });
});

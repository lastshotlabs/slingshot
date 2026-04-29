import { describe, expect, it } from 'bun:test';
import { applyGeoTransform, applyGeoTransformDetailed } from '../src/geoTransform';
import type { GeoSearchConfig } from '@lastshotlabs/slingshot-core';

const geoConfig: GeoSearchConfig = {
  latField: 'latitude',
  lngField: 'longitude',
};

describe('applyGeoTransform', () => {
  it('adds _geo field when both coordinates are present', () => {
    const doc = { id: '1', name: 'Cafe', latitude: 48.85, longitude: 2.35 };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toEqual({
      id: '1',
      name: 'Cafe',
      latitude: 48.85,
      longitude: 2.35,
      _geo: { lat: 48.85, lng: 2.35 },
    });
  });

  it('returns doc unchanged when lat is null', () => {
    const doc = { id: '2', name: 'No Lat', latitude: null, longitude: 2.35 };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toBe(doc);
  });

  it('returns doc unchanged when lng is null', () => {
    const doc = { id: '3', name: 'No Lng', latitude: 48.85, longitude: null };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toBe(doc);
  });

  it('returns doc unchanged when lat is undefined (missing key)', () => {
    const doc = { id: '4', name: 'Missing Lat', longitude: 2.35 };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toBe(doc);
  });

  it('returns doc unchanged when lng is undefined (missing key)', () => {
    const doc = { id: '5', name: 'Missing Lng', latitude: 48.85 };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toBe(doc);
  });

  it('returns doc unchanged when both coordinates are missing', () => {
    const doc = { id: '6', name: 'No coordinates' };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toBe(doc);
  });

  it('coerces numeric strings to numbers', () => {
    const doc = { id: '7', latitude: '48.85', longitude: '2.35' };
    const result = applyGeoTransform(doc, geoConfig);
    expect(result).toEqual({
      id: '7',
      latitude: '48.85',
      longitude: '2.35',
      _geo: { lat: 48.85, lng: 2.35 },
    });
  });

  it('does not mutate the original document', () => {
    const doc = { id: '8', latitude: 48.85, longitude: 2.35 };
    const original = { ...doc };
    applyGeoTransform(doc, geoConfig);
    expect(doc).toEqual(original);
  });
});

describe('applyGeoTransformDetailed', () => {
  it('returns applied:true with _geo field when both coordinates present', () => {
    const doc = { id: 'a', latitude: 1, longitude: 2 };
    const result = applyGeoTransformDetailed(doc, geoConfig);
    expect(result.applied).toBe(true);
    expect(result.document._geo).toEqual({ lat: 1, lng: 2 });
  });

  it('returns applied:false with reason missingLat', () => {
    const doc = { id: 'b', latitude: null, longitude: 2 };
    const result = applyGeoTransformDetailed(doc, geoConfig);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('missingLat');
    expect(result.document).toBe(doc);
  });

  it('returns applied:false with reason missingLng', () => {
    const doc = { id: 'c', latitude: 1 };
    const result = applyGeoTransformDetailed(doc, geoConfig);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('missingLng');
    expect(result.document).toBe(doc);
  });

  it('returns applied:false with reason missingBoth', () => {
    const doc = { id: 'd' };
    const result = applyGeoTransformDetailed(doc, geoConfig);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('missingBoth');
    expect(result.document).toBe(doc);
  });
});

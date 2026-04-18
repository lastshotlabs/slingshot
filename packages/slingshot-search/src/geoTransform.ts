/**
 * Geo-coordinate transform for search document indexing.
 *
 * Converts separate lat/lng entity fields into the `_geo: { lat, lng }`
 * composite field expected by search providers (Meilisearch, Typesense,
 * Elasticsearch, Algolia). Applied to every document before it is sent to
 * the provider, both during event-bus sync and during reindex operations.
 */
import type { GeoSearchConfig } from '@lastshotlabs/slingshot-core';

/**
 * Transform a search document by merging separate latitude and longitude fields
 * into the composite `_geo: { lat, lng }` field required by search providers.
 *
 * @param doc - The search document (already run through the entity transform
 *   function). The original `latField` and `lngField` values are preserved
 *   alongside the new `_geo` field.
 * @param geoConfig - The entity's geo search configuration, specifying which
 *   document fields hold the latitude and longitude values.
 * @returns A new document object with the `_geo` composite field added, or the
 *   original `doc` reference unchanged if either coordinate is missing (`null`
 *   or `undefined`).
 *
 * @remarks
 * **Coordinate ordering** — the composite field always uses `{ lat, lng }`
 * (latitude first). Meilisearch and Typesense use this convention natively.
 * Elasticsearch uses `{ lat, lon }` — the Elasticsearch provider translates
 * the `_geo.lng` to `_geo.lon` internally when building geo queries.
 *
 * **Type coercion** — latitude and longitude values are coerced to `number`
 * via `Number()`. If the source fields contain numeric strings (e.g. from a
 * CSV import) they will be converted correctly. Non-numeric strings produce
 * `NaN` which may cause provider-level indexing errors — ensure source data
 * is clean before indexing.
 *
 * **Partial coordinates** — if either `latField` or `lngField` is missing on
 * the document, the `_geo` field is not added and the original document object
 * is returned as-is. This avoids indexing a malformed geo point.
 *
 * @example
 * ```ts
 * import { applyGeoTransform } from '@lastshotlabs/slingshot-search';
 *
 * const doc = { id: '1', name: 'Cafe', latitude: 48.85, longitude: 2.35 };
 * const geoConfig = { latField: 'latitude', lngField: 'longitude' };
 *
 * applyGeoTransform(doc, geoConfig);
 * // { id: '1', name: 'Cafe', latitude: 48.85, longitude: 2.35,
 * //   _geo: { lat: 48.85, lng: 2.35 } }
 *
 * // Missing coordinates — returned unchanged:
 * applyGeoTransform({ id: '2', name: 'No location' }, geoConfig);
 * // { id: '2', name: 'No location' }
 * ```
 */
export function applyGeoTransform(
  doc: Record<string, unknown>,
  geoConfig: GeoSearchConfig,
): Record<string, unknown> {
  const lat = doc[geoConfig.latField];
  const lng = doc[geoConfig.lngField];
  if (lat != null && lng != null) {
    return { ...doc, _geo: { lat: Number(lat), lng: Number(lng) } };
  }
  return doc;
}

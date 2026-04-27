/**
 * SearchFilter evaluation for the DB-native provider.
 *
 * Evaluates filter AST nodes against in-memory documents.
 */
import type { SearchFilter, SearchFilterCondition } from '../types/query';

/**
 * Retrieve a possibly-nested value from a plain object using dot-notation.
 *
 * Traverses `obj` one segment at a time, stopping early and returning
 * `undefined` if any intermediate value is `null` or `undefined`.
 *
 * @param obj - The root object to traverse.
 * @param path - Dot-separated field path, e.g. `"address.city"` or `"score"`.
 * @returns The value at the path, or `undefined` if any segment is absent.
 *
 * @example
 * ```ts
 * getNestedValue({ address: { city: 'London' } }, 'address.city'); // 'London'
 * getNestedValue({ a: null }, 'a.b'); // undefined
 * getNestedValue({ x: 42 }, 'missing'); // undefined
 * ```
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single `SearchFilterCondition` leaf node against a document.
 *
 * Dispatches on `condition.op` and compares `getNestedValue(doc, condition.field)`
 * against `condition.value`. Numeric comparison operators (`>`, `>=`, `<`, `<=`,
 * `BETWEEN`) return `false` when either operand is not a number.
 *
 * @param doc - The in-memory document to test.
 * @param condition - A leaf filter node with `field`, `op`, and `value`.
 * @returns `true` if the document satisfies the condition, `false` otherwise.
 */
function evaluateCondition(
  doc: Record<string, unknown>,
  condition: SearchFilterCondition,
): boolean {
  const fieldValue = getNestedValue(doc, condition.field);
  const { op, value } = condition;

  switch (op) {
    case '=':
      return fieldValue === value;

    case '!=':
      return fieldValue !== value;

    case '>':
      if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
      return fieldValue > value;

    case '>=':
      if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
      return fieldValue >= value;

    case '<':
      if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
      return fieldValue < value;

    case '<=':
      if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
      return fieldValue <= value;

    case 'IN':
      if (!Array.isArray(value)) return false;
      return (value as ReadonlyArray<unknown>).includes(fieldValue);

    case 'NOT_IN':
      if (!Array.isArray(value)) return false;
      return !(value as ReadonlyArray<unknown>).includes(fieldValue);

    case 'EXISTS':
      return fieldValue !== undefined && fieldValue !== null;

    case 'NOT_EXISTS':
      return fieldValue === undefined || fieldValue === null;

    case 'CONTAINS':
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(value);
      }
      if (typeof fieldValue === 'string' && typeof value === 'string') {
        return fieldValue.includes(value);
      }
      return false;

    case 'BETWEEN': {
      if (typeof fieldValue !== 'number') return false;
      if (!Array.isArray(value) || value.length !== 2) return false;
      const min = value[0] as number;
      const max = value[1] as number;
      return fieldValue >= min && fieldValue <= max;
    }

    case 'STARTS_WITH':
      if (typeof fieldValue !== 'string' || typeof value !== 'string') return false;
      return fieldValue.startsWith(value);

    case 'IS_EMPTY':
      return (
        fieldValue === undefined ||
        fieldValue === null ||
        fieldValue === '' ||
        (Array.isArray(fieldValue) && fieldValue.length === 0)
      );

    case 'IS_NOT_EMPTY':
      return (
        fieldValue !== undefined &&
        fieldValue !== null &&
        fieldValue !== '' &&
        !(Array.isArray(fieldValue) && fieldValue.length === 0)
      );

    default:
      return false;
  }
}

/**
 * Recursively evaluate a `SearchFilter` AST node against an in-memory document.
 *
 * Handles all composite operators (`$and`, `$or`, `$not`), geo filters
 * (`$geoRadius`, `$geoBoundingBox`), and delegates leaf conditions to
 * `evaluateCondition`. Unknown node shapes return `false` (conservative fallback)
 * and log a warning — over-inclusion is more dangerous than under-inclusion for
 * security-relevant filter evaluation.
 *
 * @param doc - The in-memory document to test.
 * @param filter - The filter AST node to evaluate. May be arbitrarily nested.
 * @returns `true` if the document matches the filter, `false` otherwise.
 *
 * @remarks
 * Geo filters require the document to carry a `_geo` field shaped as
 * `{ lat: number; lng: number }`. Documents without `_geo` always fail geo
 * filters.
 *
 * @example
 * ```ts
 * const doc = { status: 'published', score: 8 };
 *
 * evaluateFilter(doc, { field: 'status', op: '=', value: 'published' }); // true
 * evaluateFilter(doc, { $and: [
 *   { field: 'status', op: '=', value: 'published' },
 *   { field: 'score', op: '>=', value: 5 },
 * ]}); // true
 * evaluateFilter(doc, { $not: { field: 'status', op: '=', value: 'draft' } }); // true
 * ```
 */
export function evaluateFilter(doc: Record<string, unknown>, filter: SearchFilter): boolean {
  if ('$and' in filter) {
    return filter.$and.every(f => evaluateFilter(doc, f));
  }
  if ('$or' in filter) {
    return filter.$or.some(f => evaluateFilter(doc, f));
  }
  if ('$not' in filter) {
    return !evaluateFilter(doc, filter.$not);
  }
  if ('$geoRadius' in filter) {
    // Geo radius filtering requires _geo field with lat/lng
    const geo = doc._geo as { lat?: number; lng?: number } | undefined;
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return false;
    const { lat, lng, radiusMeters } = filter.$geoRadius;
    const distance = haversineDistance(geo.lat, geo.lng, lat, lng);
    return distance <= radiusMeters;
  }
  if ('$geoBoundingBox' in filter) {
    const geo = doc._geo as { lat?: number; lng?: number } | undefined;
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return false;
    const { topLeft, bottomRight } = filter.$geoBoundingBox;
    return (
      geo.lat <= topLeft.lat &&
      geo.lat >= bottomRight.lat &&
      geo.lng >= topLeft.lng &&
      geo.lng <= bottomRight.lng
    );
  }
  // SearchFilterCondition
  if ('field' in filter && 'op' in filter) {
    return evaluateCondition(doc, filter);
  }
  // Unknown node type — return false (matches nothing) rather than true.
  // Over-inclusion is more dangerous than under-inclusion for security-relevant
  // filter evaluation. Log a warning so misconfigured filters are discoverable.
  console.warn(
    '[slingshot-search] evaluateFilter: unknown filter node type encountered — returning false (no match). Node keys:',
    Object.keys(filter),
  );
  return false;
}

// ============================================================================
// Geo utilities
// ============================================================================

/**
 * Compute the great-circle distance between two geographic coordinates in metres
 * using the Haversine formula.
 *
 * @param lat1 - Latitude of the first point in decimal degrees (−90 to +90).
 * @param lng1 - Longitude of the first point in decimal degrees (−180 to +180).
 * @param lat2 - Latitude of the second point in decimal degrees (−90 to +90).
 * @param lng2 - Longitude of the second point in decimal degrees (−180 to +180).
 * @returns Distance in **metres** as a floating-point number.
 *
 * @remarks
 * **Haversine formula** — assumes a spherical Earth with radius 6 371 000 m
 * (mean Earth radius per IUGG). The formula is:
 *
 * ```
 * a = sin²(Δlat/2) + cos(lat1) · cos(lat2) · sin²(Δlng/2)
 * c = 2 · atan2(√a, √(1-a))
 * d = R · c
 * ```
 *
 * The result has sub-metre accuracy for distances under ~20 000 km. Antipodal
 * points (exactly opposite on the globe) may accumulate floating-point error
 * near 20 015 km. For search-radius use cases this is inconsequential.
 *
 * @example
 * ```ts
 * // Distance between Big Ben (51.5007, -0.1246) and Eiffel Tower (48.8584, 2.2945)
 * haversineDistance(51.5007, -0.1246, 48.8584, 2.2945); // ~341 571 m (~341 km)
 * ```
 */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

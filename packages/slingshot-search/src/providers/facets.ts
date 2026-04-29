/**
 * Facet computation and stats for the DB-native provider.
 */
import type { FacetStats } from '../types/response';
import { getNestedValue } from './filterEval';
import { stringifySearchValue } from './stringify';

/**
 * Compute facet distribution counts and numeric statistics for a set of
 * in-memory documents.
 *
 * For each field in `facetFields`, the function:
 * 1. Counts how many documents contain each distinct string-coerced value
 *    (`distribution`). Array-valued fields are treated as multi-select facets
 *    and each non-null element is counted as its own bucket.
 * 2. Computes `min`, `max`, `avg`, and `sum` for fields whose values are
 *    numbers (`stats`). Fields with no numeric values are absent from `stats`.
 *
 * `null` / `undefined` field values are silently skipped and do not contribute
 * to counts or stats.
 *
 * @param documents - The already-filtered (pre-pagination) document set to
 *   aggregate over. Facets must be computed before slicing to a page so that
 *   counts reflect the full result set.
 * @param facetFields - Dot-notation field paths to aggregate, e.g. `['status',
 *   'author.country']`.
 * @param facetOptions - Optional per-field configuration:
 *   - `maxValues` — cap the number of buckets returned (default `100`).
 *   - `sortBy` — `'count'` (descending, default) or `'alpha'` (ascending by
 *     label).
 * @returns An object with two properties:
 *   - `distribution` — `Record<field, Record<valueLabel, count>>`.
 *   - `stats` — `Record<field, FacetStats>` present only for numeric fields.
 *
 * @remarks
 * The `distribution` for each field is truncated to `maxValues` **after**
 * sorting, so it always contains the top-N most frequent (or first-N
 * alphabetical) buckets. Increase `maxValues` if you need more granularity.
 *
 * @example
 * ```ts
 * const docs = [
 *   { status: 'published', score: 8 },
 *   { status: 'draft',     score: 3 },
 *   { status: 'published', score: 5 },
 * ];
 *
 * const { distribution, stats } = computeFacets(docs, ['status', 'score']);
 * // distribution.status → { published: 2, draft: 1 }
 * // stats.score         → { min: 3, max: 8, avg: ~5.33, sum: 16, count: 3 }
 * ```
 */
export function computeFacets(
  documents: ReadonlyArray<Record<string, unknown>>,
  facetFields: ReadonlyArray<string>,
  facetOptions?: Record<string, { maxValues?: number; sortBy?: 'count' | 'alpha' }>,
): {
  distribution: Record<string, Record<string, number>>;
  stats: Record<string, FacetStats>;
} {
  const distribution: Record<string, Record<string, number>> = {};
  const stats: Record<string, FacetStats> = {};

  for (const field of facetFields) {
    const counts: Record<string, number> = {};
    let numericSum = 0;
    let numericCount = 0;
    let numericMin = Infinity;
    let numericMax = -Infinity;

    for (const doc of documents) {
      const value = getNestedValue(doc, field);
      if (value === undefined || value === null) continue;

      const values = Array.isArray(value) ? value : [value];
      for (const facetValue of values) {
        if (facetValue === undefined || facetValue === null) continue;

        const key = stringifySearchValue(facetValue);
        counts[key] = (counts[key] ?? 0) + 1;

        if (typeof facetValue === 'number') {
          numericSum += facetValue;
          numericCount++;
          numericMin = Math.min(numericMin, facetValue);
          numericMax = Math.max(numericMax, facetValue);
        }
      }
    }

    // Apply facet options (max values, sort)
    const opts = facetOptions?.[field];
    const maxValues = opts?.maxValues ?? 100;
    const sortBy = opts?.sortBy ?? 'count';

    let entries = Object.entries(counts);
    if (sortBy === 'count') {
      entries.sort((a, b) => b[1] - a[1]);
    } else {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    }
    entries = entries.slice(0, maxValues);

    distribution[field] = Object.fromEntries(entries);

    if (numericCount > 0) {
      stats[field] = {
        min: numericMin,
        max: numericMax,
        avg: numericSum / numericCount,
        sum: numericSum,
        count: numericCount,
      };
    }
  }

  return { distribution, stats };
}

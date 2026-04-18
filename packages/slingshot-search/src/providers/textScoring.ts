/**
 * Text matching, scoring, highlighting, and match position computation
 * for the DB-native provider.
 */
import { getNestedValue } from './filterEval';
import { stringifySearchValue } from './stringify';

// ============================================================================
// Text matching & scoring
// ============================================================================

/**
 * Compute a numeric relevance score for a document against a text query.
 *
 * Splits the query into whitespace-delimited terms and accumulates a score by
 * checking each searchable field. Each term contributes points scaled by the
 * field's weight (derived from its position in `fieldWeights`):
 *
 * - **Exact match** (field value equals the term): `10 × weight`
 * - **Prefix match** (field value starts with the term): `5 × weight`
 * - **Substring match** (field value contains the term): `1 × weight`
 *
 * When `query` is empty the function returns `1` (browse mode — all documents
 * are equally ranked).
 *
 * @param doc - The document to score.
 * @param query - The raw search query string. May be empty.
 * @param searchableFields - Ordered list of field paths to examine. Earlier
 *   fields should carry higher weights via `fieldWeights`.
 * @param fieldWeights - Map from field path to a positive numeric weight.
 *   Fields absent from the map default to weight `1`.
 * @returns A non-negative score. Higher means more relevant. The value is
 *   unbounded; normalise against `maxPossibleScore` for threshold comparisons.
 *
 * @remarks
 * Comparisons are case-insensitive (both query and field values are
 * lowercased). Non-string field values are coerced via `String()`.
 *
 * @example
 * ```ts
 * const weights = new Map([['title', 3], ['body', 1]]);
 * computeTextScore({ title: 'Hello world', body: 'Foo' }, 'hello', ['title', 'body'], weights);
 * // 'title' starts with 'hello' → 5 × 3 = 15
 * ```
 */
export function computeTextScore(
  doc: Record<string, unknown>,
  query: string,
  searchableFields: ReadonlyArray<string>,
  fieldWeights: Map<string, number>,
): number {
  if (!query) return 1; // browse mode — all docs equally ranked
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let totalScore = 0;

  for (const field of searchableFields) {
    const value = getNestedValue(doc, field);
    if (value === undefined || value === null) continue;
    const text = stringifySearchValue(value).toLowerCase();
    const weight = fieldWeights.get(field) ?? 1;

    for (const term of terms) {
      // Exact field match — highest boost
      if (text === term) {
        totalScore += 10 * weight;
        continue;
      }
      // Starts with — high boost
      if (text.startsWith(term)) {
        totalScore += 5 * weight;
        continue;
      }
      // Contains — normal boost
      if (text.includes(term)) {
        totalScore += weight;
      }
    }
  }

  return totalScore;
}

/**
 * Determine whether a document satisfies a text query under the given matching
 * strategy.
 *
 * Returns `true` immediately when `query` is empty (browse mode).
 *
 * @param doc - The document to test.
 * @param query - The raw search query string. Empty string is a pass-through.
 * @param searchableFields - Field paths to check for each term.
 * @param matchingStrategy - Controls how many query terms must match:
 *   - `'all'` — every term must appear in at least one searchable field.
 *   - `'last'` — all terms except the last must match; the last term is
 *     optional (useful for search-as-you-type UX while the user is still
 *     typing the final word).
 *   - `'frequency'` — at least half the terms (rounded up) must match.
 * @returns `true` if the document passes the matching strategy.
 *
 * @example
 * ```ts
 * const fields = ['title', 'body'];
 * const doc = { title: 'Quick brown fox', body: 'jumps' };
 *
 * matchesQuery(doc, 'quick fox', fields, 'all');       // true
 * matchesQuery(doc, 'quick missing', fields, 'all');   // false
 * matchesQuery(doc, 'quick missing', fields, 'last');  // true — 'missing' is the last term
 * matchesQuery(doc, 'a b c d missing', fields, 'frequency'); // false (1/5 < ceil(5/2)=3)
 * ```
 */
export function matchesQuery(
  doc: Record<string, unknown>,
  query: string,
  searchableFields: ReadonlyArray<string>,
  matchingStrategy: 'all' | 'last' | 'frequency',
): boolean {
  if (!query) return true; // browse mode
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const matchesTerm = (term: string) =>
    searchableFields.some(field => {
      const value = getNestedValue(doc, field);
      if (value === undefined || value === null) return false;
      return stringifySearchValue(value).toLowerCase().includes(term);
    });

  switch (matchingStrategy) {
    case 'all':
      return terms.every(matchesTerm);
    case 'last':
      // All terms except last must match; last is optional (search-as-you-type)
      return terms.slice(0, -1).every(matchesTerm);
    case 'frequency':
      // At least half the terms must match
      return terms.filter(matchesTerm).length >= Math.ceil(terms.length / 2);
    default:
      return terms.every(matchesTerm);
  }
}

// ============================================================================
// Highlighting
// ============================================================================

/**
 * Wrap all occurrences of query terms within `text` with highlight tags.
 *
 * Each query term is applied in descending length order so that longer terms
 * take precedence over their shorter sub-strings. Matching is case-insensitive;
 * original casing of the source text is preserved inside the tags.
 *
 * Returns `text` unchanged when `query` is empty.
 *
 * @param text - The source string to annotate.
 * @param query - Whitespace-delimited query terms to highlight.
 * @param preTag - HTML/markup tag inserted **before** each match, e.g. `<mark>`.
 * @param postTag - HTML/markup tag inserted **after** each match, e.g. `</mark>`.
 * @returns The annotated string with matches wrapped in `preTag…postTag`.
 *
 * @example
 * ```ts
 * highlightText('Hello World', 'world', '<em>', '</em>');
 * // 'Hello <em>World</em>'
 *
 * highlightText('Quick brown fox', 'quick brown', '<b>', '</b>');
 * // '<b>Quick</b> <b>brown</b> fox'
 * ```
 */
export function highlightText(
  text: string,
  query: string,
  preTag: string,
  postTag: string,
): string {
  if (!query) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;

  // Sort terms by length descending so longer matches are applied first
  const sortedTerms = [...terms].sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    result = result.replace(regex, `${preTag}$1${postTag}`);
  }

  return result;
}

/**
 * Escape all regex special characters in `str` so it can be used as a literal
 * inside a `RegExp` constructor without unintended metacharacter interpretation.
 *
 * @param str - The raw string to escape.
 * @returns A copy of `str` with `.`, `*`, `+`, `?`, `^`, `$`, `{`, `}`,
 *   `(`, `)`, `|`, `[`, `]`, and `\` each prefixed with a backslash.
 *
 * @example
 * ```ts
 * escapeRegex('foo.bar+baz'); // 'foo\\.bar\\+baz'
 * new RegExp(escapeRegex('1+1=2')).test('1+1=2'); // true
 * ```
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Produce a highlights map for a document — one entry per field that contains
 * at least one query match.
 *
 * Iterates over each field in `highlightFields`, reads its string value from
 * `doc` via dot-notation, and applies `highlightText`. Fields that have no
 * matches (highlighted result equals the original) are omitted from the output.
 *
 * @param doc - The source document.
 * @param query - Whitespace-delimited search terms.
 * @param highlightFields - Field paths to annotate.
 * @param preTag - Tag inserted before each match, e.g. `<mark>`.
 * @param postTag - Tag inserted after each match, e.g. `</mark>`.
 * @returns A `Record<fieldPath, annotatedString>` containing only fields that
 *   had at least one match. Returns `{}` when no fields match.
 *
 * @example
 * ```ts
 * computeHighlights(
 *   { title: 'TypeScript Guide', body: 'Learn TS fast' },
 *   'typescript',
 *   ['title', 'body'],
 *   '<mark>', '</mark>',
 * );
 * // { title: '<mark>TypeScript</mark> Guide' }
 * ```
 */
export function computeHighlights(
  doc: Record<string, unknown>,
  query: string,
  highlightFields: ReadonlyArray<string>,
  preTag: string,
  postTag: string,
): Record<string, string> {
  const highlights: Record<string, string> = {};

  for (const field of highlightFields) {
    const value = getNestedValue(doc, field);
    if (value === undefined || value === null) continue;
    const text = stringifySearchValue(value);
    const highlighted = highlightText(text, query, preTag, postTag);
    if (highlighted !== text) {
      highlights[field] = highlighted;
    }
  }

  return highlights;
}

/**
 * Compute character-level match positions for every query term in each
 * searchable field.
 *
 * Positions are character offsets into the **lowercased** field value; they
 * correspond directly to indices in the original string since only casing
 * differs. All non-overlapping occurrences of each term are recorded; the
 * resulting positions are sorted by `start` ascending.
 *
 * Fields with no matches are omitted from the output. Returns `{}` when
 * `query` is empty.
 *
 * @param doc - The source document.
 * @param query - Whitespace-delimited search terms.
 * @param searchableFields - Field paths to scan.
 * @returns A map from field path to an array of `{ start, length }` objects.
 *   Each object identifies one term occurrence.
 *
 * @example
 * ```ts
 * computeMatchPositions({ title: 'foo bar foo' }, 'foo', ['title']);
 * // { title: [{ start: 0, length: 3 }, { start: 8, length: 3 }] }
 * ```
 */
export function computeMatchPositions(
  doc: Record<string, unknown>,
  query: string,
  searchableFields: ReadonlyArray<string>,
): Record<string, ReadonlyArray<{ start: number; length: number }>> {
  const positions: Record<string, Array<{ start: number; length: number }>> = {};
  if (!query) return positions;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  for (const field of searchableFields) {
    const value = getNestedValue(doc, field);
    if (value === undefined || value === null) continue;
    const text = stringifySearchValue(value).toLowerCase();
    const fieldPositions: Array<{ start: number; length: number }> = [];

    for (const term of terms) {
      let idx = 0;
      while (idx < text.length) {
        const found = text.indexOf(term, idx);
        if (found === -1) break;
        fieldPositions.push({ start: found, length: term.length });
        idx = found + 1;
      }
    }

    if (fieldPositions.length > 0) {
      fieldPositions.sort((a, b) => a.start - b.start);
      positions[field] = fieldPositions;
    }
  }

  return positions;
}

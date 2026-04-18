/**
 * Runtime filter expression evaluator.
 *
 * Pure function: takes a record, a filter expression, and resolved params,
 * returns whether the record matches.
 *
 * This is the runtime counterpart of the codegen filter compiler
 * in slingshot-data/generators/filter.ts. Same semantics, different output:
 * the compiler generates code strings, this evaluates live.
 */
import type { FilterExpression, FilterValue } from './operations';

function isParam(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('param:');
}

/**
 * Resolve a filter value to a concrete runtime value.
 *
 * Handles two special cases before passing the value through:
 * - `'param:x'` strings — looked up in `params` using the part after `'param:'` as the key.
 *   If the key is absent, `undefined` is returned.
 * - The string `'now'` — replaced with `new Date()` at call time, enabling time-relative
 *   comparisons such as `{ expiresAt: { $lt: 'now' } }`.
 * All other values are returned unchanged.
 *
 * @param v - The raw filter value from the `FilterExpression` (may be a param ref, `'now'`, or a literal).
 * @param params - Runtime parameter values keyed by name (e.g. `{ userId: 'usr_123' }`).
 * @returns The resolved runtime value — a concrete primitive, `Date`, or `undefined`.
 *
 * @example
 * ```ts
 * resolveValue('param:userId', { userId: 'usr_1' })  // → 'usr_1'
 * resolveValue('now',          {})                    // → new Date()   (current timestamp)
 * resolveValue(42,             {})                    // → 42
 * resolveValue('active',       {})                    // → 'active'
 * ```
 */
function resolveValue(v: unknown, params: Record<string, unknown>): unknown {
  if (isParam(v)) return params[v.slice(6)];
  if (v === 'now') return new Date();
  return v;
}

/**
 * Compare two values and return a numeric ordering result, similar to `Array.sort` comparators.
 *
 * Dispatch order:
 * 1. **Date vs Date** — compares epoch milliseconds (`a.getTime() - b.getTime()`).
 * 2. **Number vs Number** — numeric subtraction (`a - b`).
 * 3. **Everything else** — lexicographic string comparison via `String(a)` / `String(b)`.
 *
 * Used internally by `evaluateFieldValue` to implement `$gt`, `$gte`, `$lt`, and `$lte`
 * operators across heterogeneous value types.
 *
 * @param a - Left-hand value (the record's field value after resolution).
 * @param b - Right-hand value (the operator's target after `resolveValue`).
 * @returns Negative if `a < b`, positive if `a > b`, zero if equal.
 *
 * @example
 * ```ts
 * compareValues(new Date('2024-01-02'), new Date('2024-01-01'))  // → positive
 * compareValues(5, 10)                                            // → -5
 * compareValues('apple', 'banana')                               // → -1
 * compareValues('zebra', 'ant')                                  // → 1
 * ```
 */
function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Evaluate a single field condition from a `FilterExpression` against a record's field value.
 *
 * This is the central dispatch function for all per-field filter logic. It handles:
 * - `null` — strict null/undefined equality check.
 * - Scalar literals and `'param:x'` references — resolved via `resolveValue` then strict equality.
 * - Operator objects: `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`.
 * - Fallback — strict equality for any unrecognised shape.
 *
 * @param recordValue - The value extracted from the record for the current field key.
 * @param filterValue - The condition from the `FilterExpression` for the same field.
 * @param params - Runtime parameter values used to expand `'param:x'` references.
 * @returns `true` if `recordValue` satisfies `filterValue`; `false` otherwise.
 *
 * @remarks
 * **Runtime vs compiled evaluation:** This function performs runtime evaluation on every
 * call — no caching, no compilation. For small record sets (in-memory adapters, test
 * fixtures) this is negligible. For large datasets, prefer pushing filter predicates into
 * the storage layer (SQL `WHERE`, Mongo query, Redis scan) and only using this function
 * for post-fetch refinement or in-memory stores. The codegen counterpart in
 * `slingshot-data/generators/filter.ts` generates compiled TypeScript predicates for the
 * storage adapters; this evaluator exists for runtime flexibility.
 *
 * @example
 * ```ts
 * evaluateFieldValue('active', 'active', {})                              // → true
 * evaluateFieldValue(10, { $gte: 'param:min' }, { min: 5 })              // → true
 * evaluateFieldValue('foo', { $in: ['foo', 'bar'] }, {})                 // → true
 * evaluateFieldValue('Hello World', { $contains: 'hello' }, {})          // → true  (case-insensitive)
 * evaluateFieldValue(null, null, {})                                      // → true
 * evaluateFieldValue(undefined, null, {})                                 // → true  (== null)
 * ```
 */
function evaluateFieldValue(
  recordValue: unknown,
  filterValue: FilterValue,
  params: Record<string, unknown>,
): boolean {
  // Null check
  if (filterValue === null) {
    return recordValue == null;
  }

  // Param reference or literal
  if (
    typeof filterValue === 'string' ||
    typeof filterValue === 'number' ||
    typeof filterValue === 'boolean'
  ) {
    const resolved = resolveValue(filterValue, params);
    return recordValue === resolved;
  }

  // Operator object — after null and primitive checks, filterValue must be FilterOperator
  if ('$ne' in filterValue) {
    const target = resolveValue(filterValue.$ne, params);
    if (target === null) return recordValue != null;
    return recordValue !== target;
  }

  if ('$gt' in filterValue) {
    const target = resolveValue(filterValue.$gt, params);
    return compareValues(recordValue, target) > 0;
  }

  if ('$gte' in filterValue) {
    const target = resolveValue(filterValue.$gte, params);
    return compareValues(recordValue, target) >= 0;
  }

  if ('$lt' in filterValue) {
    const target = resolveValue(filterValue.$lt, params);
    return compareValues(recordValue, target) < 0;
  }

  if ('$lte' in filterValue) {
    const target = resolveValue(filterValue.$lte, params);
    return compareValues(recordValue, target) <= 0;
  }

  if ('$in' in filterValue) {
    return filterValue.$in.includes(recordValue as string | number);
  }

  if ('$nin' in filterValue) {
    return !filterValue.$nin.includes(recordValue as string | number);
  }

  if ('$contains' in filterValue) {
    const target = resolveValue(filterValue.$contains, params);
    const strRecord =
      recordValue == null ? '' : (recordValue as string | number | boolean).toString();
    const strTarget = target == null ? '' : String(target as string | number | boolean);
    return strRecord.toLowerCase().includes(strTarget.toLowerCase());
  }

  // Fallback: strict equality
  return recordValue === filterValue;
}

/**
 * Evaluate a `FilterExpression` against a record.
 *
 * Supports field equality, comparison operators (`$gt`, `$gte`, `$lt`, `$lte`, `$ne`),
 * set operators (`$in`, `$nin`), substring matching (`$contains`), logical composition
 * (`$and`, `$or`), `'param:x'` runtime references, and the `'now'` date sentinel.
 *
 * @param record - The record (plain object) to test against the filter.
 * @param filter - The filter expression to evaluate.
 * @param params - Resolved parameter values used to expand `'param:x'` references.
 * @returns `true` if every condition in `filter` is satisfied by `record`.
 *
 * @remarks
 * **Performance note:** `evaluateFilter` is a pure runtime interpreter — it walks the
 * filter expression tree on every call with no compilation or caching step. This is
 * intentional for in-memory adapters and tests, where datasets are small and startup
 * cost matters more than throughput. For production storage backends (Postgres, Mongo,
 * Redis), filter predicates should be translated into native queries at the adapter layer
 * rather than fetching all records and filtering here. Use the codegen counterpart in
 * `slingshot-data/generators/filter.ts` when you need compiled filter predicates.
 *
 * **Logical short-circuiting:** field conditions are evaluated first, then `$and`, then
 * `$or`. Evaluation stops as soon as a false result is found, matching standard
 * short-circuit semantics. `$and` and `$or` sub-expressions may themselves be recursive.
 *
 * @example
 * ```ts
 * import { evaluateFilter } from '@lastshotlabs/slingshot-core';
 *
 * const matches = evaluateFilter(
 *   { status: 'active', score: 42 },
 *   { status: 'active', score: { $gte: 'param:minScore' } },
 *   { minScore: 40 },
 * );
 * // → true
 * ```
 */
export function evaluateFilter(
  record: Record<string, unknown>,
  filter: FilterExpression,
  params: Record<string, unknown> = {},
): boolean {
  // Check field conditions
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    if (!evaluateFieldValue(record[key], value as FilterValue, params)) {
      return false;
    }
  }

  // Check $and — all sub-expressions must match
  if (filter.$and) {
    for (const sub of filter.$and) {
      if (!evaluateFilter(record, sub, params)) return false;
    }
  }

  // Check $or — at least one sub-expression must match
  if (filter.$or) {
    const orMatch = filter.$or.some(sub => evaluateFilter(record, sub, params));
    if (!orMatch) return false;
  }

  return true;
}

/**
 * Extract all `'param:x'` parameter names referenced in a filter expression.
 *
 * Use this to determine which runtime parameter keys need to be resolved before
 * calling `evaluateFilter`. Returns a deduplicated array.
 *
 * @param filter - The filter expression to inspect.
 * @returns An array of parameter names (e.g. `['userId', 'minScore']`).
 *
 * @example
 * ```ts
 * import { extractFilterParams } from '@lastshotlabs/slingshot-core';
 *
 * const params = extractFilterParams({ userId: 'param:userId', score: { $gte: 'param:min' } });
 * // → ['userId', 'min']
 * ```
 */
export function extractFilterParams(filter: FilterExpression): string[] {
  const params: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    if (isParam(value)) {
      params.push(value.slice(6));
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const v of Object.values(value)) {
        if (isParam(v)) params.push(v.slice(6));
      }
    }
  }

  if (filter.$and) {
    for (const sub of filter.$and) params.push(...extractFilterParams(sub));
  }
  if (filter.$or) {
    for (const sub of filter.$or) params.push(...extractFilterParams(sub));
  }

  return [...new Set(params)];
}

/**
 * Extract `'param:x'` parameter names from a match record (e.g., for `transition` or `lookup` ops).
 *
 * A match record maps entity field names to `'param:x'` references or literal values.
 * Returns only the parameter names (not literal values).
 *
 * @param match - A field-to-value mapping where values may be `'param:x'` references.
 * @returns An array of parameter names referenced in the match record.
 *
 * @example
 * ```ts
 * import { extractMatchParams } from '@lastshotlabs/slingshot-core';
 *
 * const params = extractMatchParams({ id: 'param:id', status: 'active' });
 * // → ['id']
 * ```
 */
export function extractMatchParams(match: Record<string, string | number | boolean>): string[] {
  return Object.values(match)
    .filter((v): v is string => typeof v === 'string' && v.startsWith('param:'))
    .map(v => v.slice(6));
}

/**
 * Resolve a match record against runtime params.
 *
 * Expands `'param:x'` references using the `params` map and returns a plain
 * `{ field: resolvedValue }` record. Literal values are passed through unchanged.
 *
 * @param match - A field-to-value mapping (values may be `'param:x'` references or literals).
 * @param params - The runtime parameter values to expand references against.
 * @returns A plain object with all `'param:x'` references replaced by their resolved values.
 *
 * @example
 * ```ts
 * import { resolveMatch } from '@lastshotlabs/slingshot-core';
 *
 * const resolved = resolveMatch({ id: 'param:id', status: 'active' }, { id: 'usr_123' });
 * // → { id: 'usr_123', status: 'active' }
 * ```
 */
export function resolveMatch(
  match: Record<string, string | number | boolean>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(match)) {
    resolved[key] = resolveValue(value, params);
  }
  return resolved;
}

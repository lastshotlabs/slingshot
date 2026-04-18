/**
 * Runtime executor: op.search delegation to an external search provider.
 *
 * When an entity has a search provider configured (e.g. Meilisearch, Typesense)
 * and the provider is available at runtime, `op.search` delegates to the provider
 * rather than performing a DB-native scan. This unlocks typo tolerance, relevance
 * ranking, facets, and full-text features unavailable in SQL or key-value stores.
 *
 * **Return shape:** Identical to DB-native `op.search` — plain entity objects only.
 * Provider-specific fields (highlights, scores, facets) are intentionally stripped
 * so consumers are unaffected by whether the query went to the provider or the DB.
 *
 * **Pagination:** When `op.paginate` is true, an offset-based cursor is used
 * (encoded via `encodeCursor({ offset })`). The provider receives `limit + 1` and
 * the extra result is used solely to determine `hasMore`.
 *
 * **Filter translation:** `op.filter` (a `FilterExpression`) is translated to the
 * provider's `SearchFilter` format by `translateFilter()`. Dynamic `param:*` references
 * are resolved against the `filterParams` argument at call time.
 */
import type {
  FilterExpression,
  FilterOperator,
  SearchClientLike,
  SearchOpConfig,
  SearchQueryLike,
} from '@lastshotlabs/slingshot-core';
import { decodeCursor, encodeCursor } from '../fieldUtils';

// ---------------------------------------------------------------------------
// FilterExpression → SearchFilter translation
// ---------------------------------------------------------------------------

/**
 * The normalized filter type sent to the search provider client.
 * Either a single field condition, an `$and` conjunction, or an `$or` disjunction.
 */
type SearchFilter = SearchFilterCondition | SearchFilterAnd | SearchFilterOr;

/** A single equality or comparison condition on one field. */
interface SearchFilterCondition {
  readonly field: string;
  /** Comparison operator string understood by the search provider (e.g. `'='`, `'!='`, `'IN'`). */
  readonly op: string;
  readonly value: unknown;
}

/** A conjunction of sub-filters — all must match. */
interface SearchFilterAnd {
  readonly $and: ReadonlyArray<SearchFilter>;
}

/** A disjunction of sub-filters — at least one must match. */
interface SearchFilterOr {
  readonly $or: ReadonlyArray<SearchFilter>;
}

/**
 * Guard: return `true` when `value` is a `FilterOperator` object (a comparison object
 * like `{ $gt: 5 }`) rather than a primitive equality value.
 */
function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Translate a single `FilterOperator` (e.g. `{ $gt: 5 }`) on one `field` into the
 * provider's `SearchFilter` condition format.
 *
 * Supported operators: `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`.
 * Unknown operators fall back to `op: '='` with a `null` value (should not occur with
 * well-typed input).
 */
function translateOperator(field: string, operator: FilterOperator): SearchFilter {
  if ('$ne' in operator) return { field, op: '!=', value: operator.$ne };
  if ('$gt' in operator) return { field, op: '>', value: operator.$gt };
  if ('$gte' in operator) return { field, op: '>=', value: operator.$gte };
  if ('$lt' in operator) return { field, op: '<', value: operator.$lt };
  if ('$lte' in operator) return { field, op: '<=', value: operator.$lte };
  if ('$in' in operator) return { field, op: 'IN', value: operator.$in as unknown[] };
  if ('$nin' in operator) return { field, op: 'NOT_IN', value: operator.$nin as unknown[] };
  if ('$contains' in operator) return { field, op: 'CONTAINS', value: operator.$contains };
  // Fallback — shouldn't happen with well-typed input
  return { field, op: '=', value: null };
}

/**
 * Translate a slingshot-core `FilterExpression` to a search-provider `SearchFilter`.
 *
 * Handles `$and` / `$or` logical operators recursively, field equality conditions,
 * and `FilterOperator` comparison objects. Dynamic `param:*` references are resolved
 * against `params` at translation time (not deferred).
 *
 * @param filter - The `FilterExpression` from the `op.search` config.
 * @param params - Runtime parameter values; keys map to `param:key` placeholders in the filter.
 * @returns A `SearchFilter` ready for the provider client, or `undefined` if the filter
 *          produced no conditions (e.g. empty expression object).
 */
export function translateFilter(
  filter: FilterExpression,
  params: Record<string, unknown>,
): SearchFilter | undefined {
  const conditions: SearchFilter[] = [];

  // Process $and / $or
  if (filter.$and) {
    const inner = filter.$and
      .map(f => translateFilter(f, params))
      .filter((f): f is SearchFilter => f !== undefined);
    if (inner.length > 0) conditions.push({ $and: inner });
  }
  if (filter.$or) {
    const inner = filter.$or
      .map(f => translateFilter(f, params))
      .filter((f): f is SearchFilter => f !== undefined);
    if (inner.length > 0) conditions.push({ $or: inner });
  }

  // Process field conditions
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;

    if (isFilterOperator(value)) {
      conditions.push(translateOperator(key, value));
    } else {
      // Resolve param references: 'param:fieldName' → params[fieldName]
      let resolved: string | number | boolean | null =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : null;
      if (typeof value === 'string' && value.startsWith('param:')) {
        const paramKey = value.slice(6);
        const paramVal = params[paramKey] ?? null;
        resolved =
          typeof paramVal === 'string' ||
          typeof paramVal === 'number' ||
          typeof paramVal === 'boolean' ||
          paramVal === null
            ? paramVal
            : null;
      }
      conditions.push({ field: key, op: '=', value: resolved });
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

// ---------------------------------------------------------------------------
// Provider search executor
// ---------------------------------------------------------------------------

/**
 * Create a search function that delegates to the configured search provider.
 *
 * The returned function has the same call signature and return shape as the
 * DB-native `op.search` executors, so the wiring layer can substitute one for
 * the other transparently.
 *
 * **Return shape:**
 * - Without `op.paginate`: `Entity[]` (plain array, optionally clamped to `limit`).
 * - With `op.paginate`: `{ items: Entity[], nextCursor?: string, hasMore: boolean }`.
 *
 * **Cursor format:** Offset-based (`{ offset: number }`) encoded with `encodeCursor`.
 * This differs from the DB-native field-value cursors, but is opaque to callers.
 *
 * @param op              - The `SearchOpConfig` with optional `filter` and `paginate` settings.
 * @param getSearchClient - Factory that returns the active `SearchClientLike` or `null`.
 *                          Called on every search invocation so provider availability is
 *                          re-checked at runtime without adapter re-creation.
 * @param ensureReady     - Async initializer to await before the first search call
 *                          (e.g. waits for the Reflect-injected search sync to complete).
 * @returns An async function `(query, filterParams?, limit?, cursor?) => Promise<Entity[] | PaginatedResult>`.
 * @throws {Error} When `getSearchClient()` returns `null` or a client without `.search()`.
 *
 * @example
 * ```ts
 * const search = searchViaProvider(op, () => searchClient, ensureReady);
 * const results = await search('hello world', { tenantId: 'abc' }, 20);
 * ```
 */
export function searchViaProvider(
  op: SearchOpConfig,
  getSearchClient: () => SearchClientLike | null,
  ensureReady: () => Promise<void>,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  return async (query, filterParams, limit, cursor) => {
    await ensureReady();

    const client = getSearchClient();
    if (!client?.search) {
      // Provider not available or client doesn't support search — should not
      // normally be called (the wiring layer checks before delegating), but
      // defensive guard.
      throw new Error('[op.search] Search provider client is not available');
    }

    // Build the search query
    const effectiveLimit = limit ?? 50;
    let offset = 0;
    if (cursor) {
      try {
        const decoded = decodeCursor(cursor);
        offset = typeof decoded.offset === 'number' ? decoded.offset : 0;
      } catch {
        offset = 0;
      }
    }

    const searchQuery: SearchQueryLike = {
      q: query,
      filter: op.filter ? translateFilter(op.filter, filterParams ?? {}) : undefined,
      limit: op.paginate ? effectiveLimit + 1 : (limit ?? undefined),
      offset: offset > 0 ? offset : undefined,
    };

    const response = await client.search(searchQuery);

    // Map hits to plain entities (drop highlights, scores, etc.)
    const entities = response.hits.map(hit => ({ ...hit.document }));

    // Return in the same shape as DB-native op.search
    if (!op.paginate) {
      return limit ? entities.slice(0, limit) : entities;
    }

    // Paginated: check hasMore via fetching one extra
    const hasMore = entities.length > effectiveLimit;
    const resultItems = hasMore ? entities.slice(0, effectiveLimit) : entities;
    const nextCursor = hasMore ? encodeCursor({ offset: offset + effectiveLimit }) : undefined;

    return { items: resultItems, nextCursor, hasMore };
  };
}

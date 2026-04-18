import { z } from 'zod';
import type { ZodType } from 'zod';
import { registerSchema } from './createRoute';

/**
 * Default overrides for offset-based pagination query parameters.
 * All fields are optional — omitted fields fall back to framework defaults (limit=50, offset=0, maxLimit=200).
 */
export interface OffsetParamDefaults {
  /** Default page size when the client omits `limit`. Defaults to 50. */
  limit?: number;
  /** Maximum page size the client may request. Defaults to 200. */
  maxLimit?: number;
  /** Default offset when the client omits `offset`. Defaults to 0. */
  offset?: number;
}

/**
 * Parsed and clamped offset pagination parameters ready for use in a query.
 */
export interface ParsedOffsetParams {
  /** Clamped to [1, maxLimit]. */
  limit: number;
  /** Clamped to [0, ∞). */
  offset: number;
}

/**
 * Build a Zod schema for offset-based pagination query parameters (`limit`, `offset`).
 *
 * Both params are strings (from query strings) — call `parseOffsetParams()` to convert
 * them to numbers before passing to a repository.
 *
 * @param defaults - Optional overrides for default/max limit and default offset.
 * @returns A Zod object schema for use in `createRoute` query validation.
 *
 * @example
 * ```ts
 * import { offsetParams } from '@lastshotlabs/slingshot-core';
 *
 * const route = createRoute({
 *   method: 'get', path: '/items',
 *   request: { query: offsetParams({ limit: 20, maxLimit: 100 }) },
 *   responses: { 200: { content: { 'application/json': { schema: ItemsResponse } } } },
 * });
 * ```
 */
export function offsetParams(defaults?: OffsetParamDefaults) {
  const defaultLimit = defaults?.limit ?? 50;
  const defaultOffset = defaults?.offset ?? 0;
  const maxLimit = defaults?.maxLimit ?? 200;
  return z.object({
    limit: z
      .string()
      .optional()
      .describe(`Number of items to return (1-${maxLimit}, default ${defaultLimit})`),
    offset: z.string().optional().describe(`Number of items to skip (default ${defaultOffset})`),
  });
}

/**
 * Parse and clamp raw offset pagination query strings to safe numeric values.
 *
 * Converts the string values produced by Hono's query parsing into validated numbers,
 * applying configured defaults when the client omits a parameter and clamping to the
 * allowed range.
 *
 * @param raw - Raw query param strings (e.g. from `c.req.valid('query')`).
 * @param defaults - Optional overrides for default/max limit and default offset.
 * @returns `{ limit, offset }` ready for repository `list()` calls.
 *
 * @example
 * ```ts
 * import { parseOffsetParams } from '@lastshotlabs/slingshot-core';
 *
 * const { limit, offset } = parseOffsetParams(c.req.valid('query'), { limit: 20 });
 * const result = await repo.list({ limit, offset });
 * ```
 */
export function parseOffsetParams(
  raw: { limit?: string; offset?: string },
  defaults?: OffsetParamDefaults,
): ParsedOffsetParams {
  const defaultLimit = defaults?.limit ?? 50;
  const maxLimit = defaults?.maxLimit ?? 200;
  const defaultOffset = defaults?.offset ?? 0;

  const rawLimit = parseInt(raw.limit ?? '', 10);
  const rawOffset = parseInt(raw.offset ?? '', 10);

  const limit = isNaN(rawLimit) ? defaultLimit : Math.min(Math.max(rawLimit, 1), maxLimit);
  const offset = isNaN(rawOffset) ? defaultOffset : Math.max(rawOffset, 0);

  return { limit, offset };
}

/**
 * Build a Zod schema for a standard offset-paginated response envelope and register it
 * in `components/schemas` under `name`.
 *
 * The schema wraps an array of `itemSchema` with `total`, `limit`, and `offset` fields.
 *
 * @param itemSchema - The Zod schema for a single item in the list.
 * @param name - The OpenAPI component schema name (e.g. `'ListItemsResponse'`).
 * @returns The registered Zod wrapper schema.
 *
 * @example
 * ```ts
 * import { paginatedResponse } from '@lastshotlabs/slingshot-core';
 *
 * const ItemsResponse = paginatedResponse(ItemSchema, 'ListItemsResponse');
 * // { items: Item[], total: number, limit: number, offset: number }
 * ```
 */
export function paginatedResponse<T extends ZodType>(itemSchema: T, name: string) {
  const wrapper = z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
  registerSchema(name, wrapper);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Cursor-based pagination
// ---------------------------------------------------------------------------

/**
 * Default overrides for cursor-based pagination query parameters.
 * Omitted fields fall back to framework defaults (limit=50, maxLimit=200).
 */
export interface CursorParamDefaults {
  /** Default page size when the client omits `limit`. Defaults to 50. */
  limit?: number;
  /** Maximum page size the client may request. Defaults to 200. */
  maxLimit?: number;
}

/**
 * Parsed and clamped cursor pagination parameters ready for use in a query.
 */
export interface ParsedCursorParams {
  /** Clamped to [1, maxLimit]. */
  limit: number;
  /** Opaque cursor string from a previous response, or `undefined` for the first page. */
  cursor: string | undefined;
}

/**
 * Build a Zod schema for cursor-based pagination query parameters (`limit`, `cursor`).
 *
 * @param defaults - Optional overrides for default/max limit.
 * @returns A Zod object schema for use in `createRoute` query validation.
 *
 * @example
 * ```ts
 * import { cursorParams } from '@lastshotlabs/slingshot-core';
 *
 * const route = createRoute({
 *   method: 'get', path: '/posts',
 *   request: { query: cursorParams({ limit: 25 }) },
 *   responses: { 200: { content: { 'application/json': { schema: PostsResponse } } } },
 * });
 * ```
 */
export function cursorParams(defaults?: CursorParamDefaults) {
  const defaultLimit = defaults?.limit ?? 50;
  const maxLimit = defaults?.maxLimit ?? 200;
  return z.object({
    limit: z
      .string()
      .optional()
      .describe(`Number of items to return (1-${maxLimit}, default ${defaultLimit})`),
    cursor: z.string().optional().describe('Opaque pagination cursor from a previous response'),
  });
}

/**
 * Parse and clamp raw cursor pagination query strings to safe values.
 *
 * @param raw - Raw query param strings (e.g. from `c.req.valid('query')`).
 * @param defaults - Optional overrides for default/max limit.
 * @returns `{ limit, cursor }` ready for repository `list()` calls.
 *
 * @example
 * ```ts
 * import { parseCursorParams } from '@lastshotlabs/slingshot-core';
 *
 * const { limit, cursor } = parseCursorParams(c.req.valid('query'));
 * const result = await repo.list({ limit, cursor });
 * return c.json({ items: result.items, nextCursor: result.nextCursor });
 * ```
 */
export function parseCursorParams(
  raw: { limit?: string; cursor?: string },
  defaults?: CursorParamDefaults,
): ParsedCursorParams {
  const defaultLimit = defaults?.limit ?? 50;
  const maxLimit = defaults?.maxLimit ?? 200;

  const rawLimit = parseInt(raw.limit ?? '', 10);
  const limit = isNaN(rawLimit) ? defaultLimit : Math.min(Math.max(rawLimit, 1), maxLimit);
  const cursor = raw.cursor || undefined;

  return { limit, cursor };
}

/**
 * Build a Zod schema for a standard cursor-paginated response envelope and register it
 * in `components/schemas` under `name`.
 *
 * The schema wraps an array of `itemSchema` with an optional `nextCursor` field.
 *
 * @param itemSchema - The Zod schema for a single item in the list.
 * @param name - The OpenAPI component schema name (e.g. `'ListPostsResponse'`).
 * @returns The registered Zod wrapper schema.
 *
 * @example
 * ```ts
 * import { cursorPaginatedResponse } from '@lastshotlabs/slingshot-core';
 *
 * const PostsResponse = cursorPaginatedResponse(PostSchema, 'ListPostsResponse');
 * // { items: Post[], nextCursor?: string }
 * ```
 */
export function cursorPaginatedResponse<T extends ZodType>(itemSchema: T, name: string) {
  const wrapper = z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
  });
  registerSchema(name, wrapper);
  return wrapper;
}

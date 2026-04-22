import { signCursor, verifyCursor } from '@lib/signing';
import type { SigningConfig } from '@lib/signingConfig';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { registerSchema } from '@lastshotlabs/slingshot-core';

export type { PaginationOptions, PaginatedResult } from '@lastshotlabs/slingshot-core';

export { offsetParams, parseOffsetParams, paginatedResponse } from '@lastshotlabs/slingshot-core';
export { cursorPaginatedResponse } from '@lastshotlabs/slingshot-core';
export type { OffsetParamDefaults, ParsedOffsetParams } from '@lastshotlabs/slingshot-core';

/**
 * Default values for cursor-based pagination query parameters.
 */
export interface CursorParamDefaults {
  /** Default number of items per page (default `50`). */
  limit?: number;
  /** Maximum allowed `limit` value (default `200`). */
  maxLimit?: number;
}

/**
 * Parsed and validated cursor pagination parameters ready for adapter consumption.
 */
export interface ParsedCursorParams {
  /** Clamped page size. */
  limit: number;
  /** Decoded opaque cursor, or `undefined` on the first page. */
  cursor: string | undefined;
}

/**
 * A single page of cursor-paginated results.
 */
export interface CursorResult<T> {
  /** The items in this page. */
  items: T[];
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
  /** `true` when more items exist beyond this page. */
  hasMore: boolean;
}

/**
 * Build a Zod schema for cursor-based pagination query parameters (`limit`, `cursor`).
 *
 * @param defaults - Optional default and max limit values.
 * @returns A Zod object schema suitable for use in route parameter validation.
 */
export function cursorParams(defaults?: CursorParamDefaults) {
  const defaultLimit = defaults?.limit ?? 50;
  const maxLimit = defaults?.maxLimit ?? 200;
  return z.object({
    limit: z
      .string()
      .optional()
      .describe(`Number of items to return (1-${maxLimit}, default ${defaultLimit})`),
    cursor: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous response's nextCursor field"),
  });
}

/**
 * Parse raw cursor pagination query strings into typed, clamped values.
 *
 * When cursor signing is configured, the incoming cursor is verified before
 * use. An invalid signature sets `invalidCursor: true` and clears the cursor.
 *
 * @param raw - Raw query string values from the request.
 * @param defaults - Optional default and max limit values.
 * @param signing - Optional signing config for HMAC-verified cursors.
 * @returns Parsed params with an optional `invalidCursor` flag.
 */
export function parseCursorParams(
  raw: { limit?: string; cursor?: string },
  defaults?: CursorParamDefaults,
  signing?: { config: SigningConfig | null; secret: string | string[] | null },
): ParsedCursorParams & { invalidCursor?: true } {
  const defaultLimit = defaults?.limit ?? 50;
  const maxLimit = defaults?.maxLimit ?? 200;

  const rawLimit = parseInt(raw.limit ?? '', 10);
  const limit = isNaN(rawLimit) ? defaultLimit : Math.min(Math.max(rawLimit, 1), maxLimit);

  if (!raw.cursor) return { limit, cursor: undefined };

  if (signing?.config?.cursors && signing.secret) {
    const verified = verifyCursor(raw.cursor, signing.secret);
    if (verified === null) return { limit, cursor: undefined, invalidCursor: true };
    return { limit, cursor: verified };
  }

  return { limit, cursor: raw.cursor };
}

/**
 * HMAC-sign a cursor string when cursor signing is enabled, otherwise return it unchanged.
 *
 * @param cursor - The raw cursor to sign, or `null`.
 * @param signing - Optional signing config. When absent or disabled, the cursor is returned as-is.
 * @returns The signed cursor string, or `null` if the input was `null`.
 */
export function maybeSignCursor(
  cursor: string | null,
  signing?: { config: SigningConfig | null; secret: string | string[] | null },
): string | null {
  if (!cursor) return cursor;
  if (signing?.config?.cursors && signing.secret) {
    return signCursor(cursor, signing.secret);
  }
  return cursor;
}

/**
 * Build a Zod schema for a cursor-paginated response and register it in the
 * OpenAPI schema registry under the given `name`.
 *
 * @param itemSchema - Zod schema for individual items in the `items` array.
 * @param name - Schema name used for OpenAPI `$ref` registration.
 * @returns A Zod object schema with `items`, `nextCursor`, and `hasMore` fields.
 */
export function cursorResponse<T extends ZodType>(itemSchema: T, name: string) {
  const wrapper = z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
  registerSchema(name, wrapper);
  return wrapper;
}

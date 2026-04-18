import { signCursor, verifyCursor } from '@lib/signing';
import type { SigningConfig } from '@lib/signingConfig';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { registerSchema } from '@lastshotlabs/slingshot-core';

export type { PaginationOptions, PaginatedResult } from '@lastshotlabs/slingshot-core';

export { offsetParams, parseOffsetParams, paginatedResponse } from '@lastshotlabs/slingshot-core';
export { cursorPaginatedResponse } from '@lastshotlabs/slingshot-core';
export type { OffsetParamDefaults, ParsedOffsetParams } from '@lastshotlabs/slingshot-core';

export interface CursorParamDefaults {
  limit?: number;
  maxLimit?: number;
}

export interface ParsedCursorParams {
  limit: number;
  cursor: string | undefined;
}

export interface CursorResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

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

export function cursorResponse<T extends ZodType>(itemSchema: T, name: string) {
  const wrapper = z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
  registerSchema(name, wrapper);
  return wrapper;
}

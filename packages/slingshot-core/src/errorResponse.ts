import type { Context } from 'hono';
import type { AppEnv } from './context';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 418 | 422 | 429 | 500 | 501 | 502 | 503;

/**
 * Build a consistent JSON error response that always includes `requestId`.
 *
 * Replaces the common `c.json({ error: '…' }, status)` pattern so every
 * error the client sees carries the request-id for support/debugging.
 *
 * @param c - The Hono request context. Must have `requestId` set by the framework middleware.
 * @param message - Human-readable error message included in the response body as `error`.
 * @param status - HTTP error status code to send.
 * @returns A typed Hono JSON response with body `{ error: string; requestId: string }`.
 *
 * @example
 * ```ts
 * import { errorResponse } from '@lastshotlabs/slingshot-core';
 *
 * app.get('/items/:id', async (c) => {
 *   const item = await getItem(c.req.param('id'));
 *   if (!item) return errorResponse(c, 'Item not found', 404);
 *   return c.json(item);
 * });
 * ```
 */
export function errorResponse<E extends AppEnv, S extends ErrorStatus>(
  c: Context<E>,
  message: string,
  status: S,
) {
  const requestId = c.get('requestId');
  return c.json({ error: message, requestId }, status);
}

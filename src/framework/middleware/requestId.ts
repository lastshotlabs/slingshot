import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HEADER_REQUEST_ID } from '@lastshotlabs/slingshot-core';

/**
 * Hono middleware that generates and propagates a unique request identifier.
 *
 * A fresh UUID v4 is generated **server-side** on every request.  Client-supplied
 * `X-Request-Id` headers are intentionally ignored — accepting client-provided
 * values would allow audit log spoofing and idempotency key manipulation.
 *
 * The ID is:
 * - Set on the Hono context via `c.set('requestId', id)` so it is accessible
 *   in all subsequent middleware and route handlers.
 * - Written to the `X-Request-Id` **response** header after the handler chain
 *   completes, allowing clients to correlate requests with server-side logs.
 */
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Always generate server-side — never trust client-supplied request IDs.
  // Accepting client values allows audit log spoofing and idempotency manipulation.
  const id = crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.res.headers.set(HEADER_REQUEST_ID, id);
};

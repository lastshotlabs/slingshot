import type { Context } from 'hono';

/**
 * Read the parsed JSON body from a Hono context without consuming the
 * body stream. Relies on Hono's built-in body caching — `c.req.json()`
 * parses on first call and stores the result; subsequent calls return
 * the cached value.
 *
 * Returns `null` on:
 *   - non-JSON content type
 *   - empty body (GET/DELETE)
 *   - malformed JSON (resolver receives `null` input; it may deny)
 *
 * Never throws — policy evaluation must never 500 on a client body issue.
 */
export async function safeReadJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
    return null;
  }
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

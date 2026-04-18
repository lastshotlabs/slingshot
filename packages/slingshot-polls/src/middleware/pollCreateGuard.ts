/**
 * Poll creation guard middleware.
 *
 * Validates the `options` JSON field via the parameterized Zod schema
 * (entity framework has no per-field Zod hook at write time, so JSON-field
 * validation lives in a named middleware). Also injects `authorId` from
 * the authenticated user context.
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { buildPollSchemas } from '../validation/polls';

/**
 * Build the poll create guard middleware.
 *
 * Captures the Zod schema (built from plugin config limits) via closure.
 * Registered under the name `'pollCreateGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildPollCreateGuard({
  schema,
}: {
  schema: ReturnType<typeof buildPollSchemas>['PollCreateInputSchema'];
}) {
  return async (c: Context, next: Next) => {
    const body: unknown = await c.req.json();

    // Validate body against the parameterized schema.
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new HTTPException(400, {
        message: result.error.issues.map(i => i.message).join('; '),
      });
    }
    await next();
  };
}

import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `validation` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Controls how request-body validation errors are serialised and returned to
 * clients. The framework validates request bodies against entity schemas before
 * calling route handlers; this section lets applications customise the error
 * response format.
 *
 * @remarks
 * **Fields:**
 * - `formatError` — Function `(error: ZodError, c: Context) => unknown` that
 *   transforms a raw Zod validation error into the response body returned to
 *   the client. The return value is JSON-serialised and sent with a 422 status.
 *   When omitted, the framework uses its default error format:
 *   `{ errors: ZodIssue[] }`.
 *
 * **Default behaviour when omitted:** Validation errors are returned as:
 * ```json
 * { "errors": [{ "path": ["fieldName"], "message": "Required" }] }
 * ```
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * validation: {
 *   formatError: (error, c) => ({
 *     message: 'Validation failed',
 *     fields: Object.fromEntries(
 *       error.issues.map(i => [i.path.join('.'), i.message])
 *     ),
 *   }),
 * }
 * ```
 */
export const validationSchema = z.object({
  formatError: fnSchema.optional(),
});

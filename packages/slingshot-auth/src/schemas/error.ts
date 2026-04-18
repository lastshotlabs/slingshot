import { z } from 'zod';

/**
 * Canonical error response schema shared across all standard auth routes.
 *
 * Exported for use in OpenAPI/Zod-based API documentation and custom route handlers
 * that want to return errors in the same shape as the built-in auth endpoints.
 *
 * M2M routes use RFC 6749 error shapes and SCIM routes use RFC 7644 shapes —
 * neither uses this schema.
 *
 * @example
 * import { ErrorResponse } from '@lastshotlabs/slingshot-auth';
 *
 * // In an OpenAPI route definition
 * app.openapi(createRoute({
 *   responses: {
 *     401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Unauthorized' },
 *   },
 * }), handler);
 *
 * // Shape: { error: string }
 */
export const ErrorResponse = z
  .object({ error: z.string().describe('Human-readable error message.') })
  .openapi('ErrorResponse');

import { z } from 'zod';

/**
 * Canonical generic success response for auth routes.
 *
 * Use this for acknowledgement-style successes. Routes with domain data
 * should extend this shape or return their domain object directly.
 */
export const SuccessResponse = z
  .object({ ok: z.literal(true).describe('Operation completed successfully.') })
  .openapi('AuthSuccessResponse');

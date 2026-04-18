/**
 * Zod validation schema for the results route path params.
 *
 * @internal
 */
import { z } from 'zod';

export const PollResultsParamsSchema = z.object({
  id: z.uuid(),
});

export type PollResultsParams = z.infer<typeof PollResultsParamsSchema>;

/**
 * Zod validation schema for poll vote creation.
 *
 * `optionIndex` is validated as a non-negative integer here. The
 * `pollVoteGuard` middleware enforces `optionIndex < poll.options.length`
 * at runtime because Zod cannot cross-reference another record.
 *
 * @internal
 */
import { z } from 'zod';

export const PollVoteCreateInputSchema = z.object({
  pollId: z.uuid(),
  optionIndex: z.number().int().nonnegative(),
});

export type PollVoteCreateInput = z.infer<typeof PollVoteCreateInputSchema>;

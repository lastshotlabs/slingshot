/**
 * Zod validation schema for `PollsPluginConfig`.
 *
 * Validated at plugin construction time and frozen (Rule 12).
 *
 * @internal
 */
import { z } from 'zod';
import { PollsRateLimitConfigSchema } from './rateLimit';

export const PollsRouteKeySchema = z.enum([
  'poll.get',
  'poll.list',
  'poll.create',
  'poll.delete',
  'poll.listBySource',
  'poll.closePoll',
  'poll.results',
  'pollVote.get',
  'pollVote.list',
  'pollVote.create',
  'pollVote.delete',
  'pollVote.listByPoll',
  'pollVote.myVotes',
  'pollVote.countByOption',
]);

export const PollsPluginConfigSchema = z.object({
  closeCheckIntervalMs: z
    .number()
    .int()
    .nonnegative()
    .default(60_000)
    .describe(
      'Polling interval in milliseconds for automatically closing expired polls. Default: 60,000.',
    ),
  maxOptions: z
    .number()
    .int()
    .min(2)
    .max(50)
    .default(10)
    .describe('Maximum number of answer options allowed on a poll. Default: 10.'),
  maxQuestionLength: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(500)
    .describe('Maximum poll question length in characters. Default: 500.'),
  maxOptionLength: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe('Maximum poll option length in characters. Default: 200.'),
  mountPath: z
    .string()
    .startsWith('/')
    .default('/polls')
    .describe('URL path prefix for poll routes. Default: /polls.'),
  disableRoutes: z
    .array(PollsRouteKeySchema)
    .default([])
    .describe('Poll route keys to skip when mounting routes. Default: [].'),
  rateLimit: PollsRateLimitConfigSchema.describe('Rate-limiting configuration for poll routes.'),
});

/** Input type accepted by `createPollsPlugin()`. */
export type PollsPluginConfigInput = z.input<typeof PollsPluginConfigSchema>;

/** Resolved config after Zod parsing and defaults. */
export type ResolvedPollsPluginConfig = z.output<typeof PollsPluginConfigSchema>;

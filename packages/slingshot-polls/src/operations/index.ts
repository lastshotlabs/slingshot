/**
 * Named operations for Poll and PollVote entities.
 *
 * Standard operations use `op.lookup`, `op.transition`, and `op.aggregate`.
 * The `results` handler is mounted manually in the plugin — it needs
 * cross-entity access (poll + votes) that a single entity's `op.custom`
 * factory cannot provide.
 *
 * @internal
 */
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { Poll } from '../entities/poll';
import { PollVote } from '../entities/pollVote';

/**
 * Poll named operations.
 *
 * - `listBySource` — find polls attached to a specific piece of content.
 * - `closePoll` — transition `closed` from `false` to `true`, recording
 *   `closedBy` and `closedAt`. Manual close sets `closedBy` to the caller's
 *   user ID; the auto-close sweep passes `null`.
 */
export const pollOperations = defineOperations(Poll, {
  listBySource: op.lookup({
    fields: { sourceType: 'param:sourceType', sourceId: 'param:sourceId' },
    returns: 'many',
  }),

  closePoll: op.transition({
    field: 'closed',
    from: false,
    to: true,
    match: { id: 'param:id' },
    set: {
      closedBy: 'param:actor.id',
      closedAt: 'now',
    },
  }),
});

/**
 * PollVote named operations.
 *
 * - `listByPoll` — all votes for a given poll.
 * - `myVotes` — the authenticated user's votes on a specific poll.
 *   Uses `param:actor.id` (injected from Hono context by the framework)
 *   so the userId is never taken from the URL.
 * - `countByOption` — aggregate vote count grouped by option index.
 */
export const pollVoteOperations = defineOperations(PollVote, {
  listByPoll: op.lookup({
    fields: { pollId: 'param:pollId' },
    returns: 'many',
  }),

  myVotes: op.lookup({
    fields: { pollId: 'param:pollId', userId: 'param:actor.id' },
    returns: 'many',
  }),

  countByOption: op.aggregate({
    groupBy: 'optionIndex',
    compute: { count: 'count' },
    filter: { pollId: 'param:pollId' },
  }),
});

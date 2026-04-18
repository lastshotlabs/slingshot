/**
 * Aggregated poll results handler.
 *
 * Returns per-option vote counts with optional voter IDs. Anonymous polls
 * always store voter IDs (the uniqueness index requires it) but strip them
 * from the response — no voter identity leakage through the read surface.
 *
 * @internal
 */
import { HTTPException } from 'hono/http-exception';
import type { PollAdapter, PollVoteAdapter } from '../types/adapters';
import type { PollResult, PollResultsResponse } from '../types/public';

/**
 * Create the results handler.
 *
 * The handler is mounted as a manual route in the plugin's `setupRoutes`
 * because it needs cross-entity access (poll + votes). Each backend entry
 * in a single entity's `op.custom` factory receives only that entity's
 * primitives, so cross-entity queries cannot go through `op.custom`.
 */
export function createResultsHandler({
  pollAdapter,
  pollVoteAdapter,
}: {
  pollAdapter: PollAdapter;
  pollVoteAdapter: PollVoteAdapter;
}) {
  return async (pollId: string): Promise<PollResultsResponse> => {
    const poll = await pollAdapter.getById(pollId);
    if (!poll) throw new HTTPException(404, { message: 'Poll not found' });

    const votes = await pollVoteAdapter.listByPoll({ pollId });
    const options = poll.options;
    const counts = Array.from({ length: options.length }, () => 0);
    const voters: string[][] = options.map(() => []);

    for (const vote of votes.items) {
      counts[vote.optionIndex]++;
      if (!poll.anonymous) voters[vote.optionIndex].push(vote.userId);
    }

    return {
      poll,
      results: counts.map(
        (count, idx): PollResult => ({
          optionIndex: idx,
          count,
          voters: poll.anonymous ? undefined : voters[idx],
        }),
      ),
      totalVotes: votes.items.length,
    };
  };
}

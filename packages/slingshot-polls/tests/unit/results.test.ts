/**
 * Results handler unit tests.
 *
 * Covers enterprise invariants:
 * - Anonymous poll → voters omitted on every result row
 * - Even split → counts correct
 * - Multi-select overlapping voters → same userId in multiple option lists
 * - Missing poll → 404
 * - Zero votes → every count is 0
 */
import { describe, expect, it } from 'bun:test';
import { createResultsHandler } from '../../src/operations/results';
import type { PollAdapter, PollVoteAdapter } from '../../src/types/adapters';
import type { PollRecord, PollVoteRecord } from '../../src/types/public';

function makePoll(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: 'poll-1',
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    authorId: 'user-author',
    question: 'Pick one',
    options: ['A', 'B', 'C'],
    multiSelect: false,
    anonymous: false,
    closed: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVote(overrides: Partial<PollVoteRecord> = {}): PollVoteRecord {
  return {
    id: `vote-${Math.random().toString(36).slice(2)}`,
    pollId: 'poll-1',
    userId: 'user-1',
    optionIndex: 0,
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createHandler(poll: PollRecord | null, votes: PollVoteRecord[]) {
  const handler = createResultsHandler({
    pollAdapter: {
      getById: async () => poll,
    } as unknown as PollAdapter,
    pollVoteAdapter: {
      listByPoll: async () => ({ items: votes }),
    } as unknown as PollVoteAdapter,
  });
  return handler;
}

describe('results handler', () => {
  it('returns correct counts for even split across 3 options', async () => {
    const poll = makePoll();
    const votes = [
      makeVote({ userId: 'u1', optionIndex: 0 }),
      makeVote({ userId: 'u2', optionIndex: 1 }),
      makeVote({ userId: 'u3', optionIndex: 2 }),
    ];
    const handler = createHandler(poll, votes);

    const result = await handler('poll-1');

    expect(result.totalVotes).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].count).toBe(1);
    expect(result.results[1].count).toBe(1);
    expect(result.results[2].count).toBe(1);
    expect(result.results[0].voters).toEqual(['u1']);
    expect(result.results[1].voters).toEqual(['u2']);
    expect(result.results[2].voters).toEqual(['u3']);
  });

  // Enterprise invariant: "Anonymous poll → no voter identity leakage"
  it('omits voters on anonymous polls', async () => {
    const poll = makePoll({ anonymous: true });
    const votes = [
      makeVote({ userId: 'u1', optionIndex: 0 }),
      makeVote({ userId: 'u2', optionIndex: 0 }),
      makeVote({ userId: 'u3', optionIndex: 1 }),
    ];
    const handler = createHandler(poll, votes);

    const result = await handler('poll-1');

    expect(result.totalVotes).toBe(3);
    expect(result.results[0].count).toBe(2);
    expect(result.results[0].voters).toBeUndefined();
    expect(result.results[1].count).toBe(1);
    expect(result.results[1].voters).toBeUndefined();
    expect(result.results[2].count).toBe(0);
    expect(result.results[2].voters).toBeUndefined();
  });

  it('handles multi-select with overlapping voters', async () => {
    const poll = makePoll({ multiSelect: true });
    const votes = [
      makeVote({ userId: 'u1', optionIndex: 0 }),
      makeVote({ userId: 'u1', optionIndex: 1 }), // same user, different option
      makeVote({ userId: 'u2', optionIndex: 1 }),
    ];
    const handler = createHandler(poll, votes);

    const result = await handler('poll-1');

    expect(result.totalVotes).toBe(3);
    // u1 appears in both option 0 and option 1 voter lists.
    expect(result.results[0].voters).toEqual(['u1']);
    expect(result.results[1].voters).toEqual(['u1', 'u2']);
  });

  it('throws 404 for missing poll', async () => {
    const handler = createHandler(null, []);

    await expect(handler('nonexistent')).rejects.toThrow();
    try {
      await handler('nonexistent');
    } catch (e: unknown) {
      const err = e as { status?: number };
      expect(err.status).toBe(404);
    }
  });

  it('returns zero counts with no crashes when no votes exist', async () => {
    const poll = makePoll();
    const handler = createHandler(poll, []);

    const result = await handler('poll-1');

    expect(result.totalVotes).toBe(0);
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.count).toBe(0);
      expect(r.voters).toEqual([]);
    }
  });

  it('includes the poll record in the response', async () => {
    const poll = makePoll({ question: 'Test question' });
    const handler = createHandler(poll, []);

    const result = await handler('poll-1');

    expect(result.poll.question).toBe('Test question');
    expect(result.poll.id).toBe('poll-1');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  type UpdateScoreDeps,
  createUpdateScoreHandler,
} from '../../../src/operations/updateScore';
import type { ScoringConfig } from '../../../src/types/config';

const DEFAULT_SCORING: ScoringConfig = {
  algorithm: 'net',
  upvoteWeight: 1,
  downvoteWeight: 1,
  hotDecayHours: 12,
  emojiWeights: {},
};

interface Reaction {
  type: string;
  value?: string | null;
}

interface UpdateCall {
  targetId: string;
  targetType: string;
  score: number;
  reactionSummary: string;
}

function buildDeps(opts: {
  reactions: Reaction[];
  target?: { createdAt?: string | Date } | null;
  scoring?: ScoringConfig;
}) {
  const updates: UpdateCall[] = [];
  const deps: UpdateScoreDeps = {
    listReactions: async () => ({ items: opts.reactions }),
    fetchTarget: async () => opts.target ?? null,
    updateTarget: async params => {
      updates.push(params);
    },
    scoring: opts.scoring ?? DEFAULT_SCORING,
  };
  return { deps, updates };
}

describe('updateScore handler', () => {
  test('computes net score from upvotes and downvotes', async () => {
    const { deps, updates } = buildDeps({
      reactions: [{ type: 'upvote' }, { type: 'upvote' }, { type: 'upvote' }, { type: 'downvote' }],
    });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'thread-1', targetType: 'thread' });

    expect(result.score).toBe(2);
    expect(updates.length).toBe(1);
    expect(updates[0]!.targetId).toBe('thread-1');
    expect(updates[0]!.score).toBe(2);

    const summary = JSON.parse(updates[0]!.reactionSummary);
    expect(summary.upvotes).toBe(3);
    expect(summary.downvotes).toBe(1);
  });

  test('counts emoji reactions', async () => {
    const { deps, updates } = buildDeps({
      reactions: [
        { type: 'emoji', value: 'heart' },
        { type: 'emoji', value: 'heart' },
        { type: 'emoji', value: 'fire' },
      ],
    });
    const handler = createUpdateScoreHandler(deps);
    await handler({ targetId: 'thread-1', targetType: 'thread' });

    const summary = JSON.parse(updates[0]!.reactionSummary);
    expect(summary.emojis.heart).toBe(2);
    expect(summary.emojis.fire).toBe(1);
  });

  test('applies emoji weights in net score', async () => {
    const scoring: ScoringConfig = {
      ...DEFAULT_SCORING,
      emojiWeights: { heart: 0.5 },
    };
    const { deps } = buildDeps({
      reactions: [
        { type: 'upvote' },
        { type: 'emoji', value: 'heart' },
        { type: 'emoji', value: 'heart' },
      ],
      scoring,
    });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'thread-1', targetType: 'thread' });
    // net = 1 * 1 - 0 * 1 + 2 * 0.5 = 2
    expect(result.score).toBe(2);
  });

  test('uses hot algorithm when configured', async () => {
    const scoring: ScoringConfig = {
      ...DEFAULT_SCORING,
      algorithm: 'hot',
    };
    const { deps, updates } = buildDeps({
      reactions: [{ type: 'upvote' }, { type: 'upvote' }],
      target: { createdAt: '2024-01-01T00:00:00Z' },
      scoring,
    });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'thread-1', targetType: 'thread' });

    // Hot score should include a time component
    expect(result.score).toBeGreaterThan(0);
    expect(updates[0]!.score).toBe(result.score);
  });

  test('uses controversial algorithm when configured', async () => {
    const scoring: ScoringConfig = {
      ...DEFAULT_SCORING,
      algorithm: 'controversial',
    };
    const { deps } = buildDeps({
      reactions: [
        { type: 'upvote' },
        { type: 'upvote' },
        { type: 'upvote' },
        { type: 'downvote' },
        { type: 'downvote' },
        { type: 'downvote' },
      ],
      scoring,
    });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'thread-1', targetType: 'thread' });

    // controversial = (3 + 3) / max(|0|, 1) = 6
    expect(result.score).toBe(6);
  });

  test('returns zero score with no reactions', async () => {
    const { deps } = buildDeps({ reactions: [] });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'thread-1', targetType: 'thread' });

    expect(result.score).toBe(0);
  });

  test('hot algorithm defaults createdAt to 0 when target is not found', async () => {
    const scoring: ScoringConfig = {
      ...DEFAULT_SCORING,
      algorithm: 'hot',
    };
    const { deps } = buildDeps({
      reactions: [{ type: 'upvote' }],
      target: null,
      scoring,
    });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'missing', targetType: 'thread' });

    // Should not throw; score should be finite
    expect(Number.isFinite(result.score)).toBe(true);
  });

  test('preserves targetId and targetType in result', async () => {
    const { deps } = buildDeps({ reactions: [{ type: 'upvote' }] });
    const handler = createUpdateScoreHandler(deps);
    const result = await handler({ targetId: 'reply-42', targetType: 'reply' });

    expect(result.targetId).toBe('reply-42');
    expect(result.targetType).toBe('reply');
  });
});

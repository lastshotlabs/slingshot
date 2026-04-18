/**
 * Handler factory for the `updateScore` custom operation on the Reaction entity.
 *
 * This is an adapter-only operation (no HTTP route). It is called from the
 * community plugin's bus event handler after a reaction is created or deleted,
 * and from `reactionBuildAdapter` which injects the handler onto the adapter
 * via `Object.defineProperty`.
 *
 * The handler:
 * 1. Lists all reactions for the target entity (`targetId`, `targetType`).
 * 2. Computes a score using the algorithm declared in `ScoringConfig`.
 * 3. Updates the target entity (`thread` or `reply`) with the new `score` and
 *    `reactionSummary` JSON.
 *
 * For the `hot` algorithm the handler fetches the target entity's `createdAt`
 * timestamp to apply the time-decay formula. When the target cannot be found,
 * `createdAt` defaults to `0` (epoch), which degrades gracefully.
 */
import { computeControversialScore, computeHotScore, computeNetScore } from '../lib/scoring';
import type { ScoringConfig } from '../types/config';

export interface UpdateScoreParams {
  readonly targetId: string;
  readonly targetType: string;
}

export interface UpdateScoreResult {
  readonly targetId: string;
  readonly targetType: string;
  readonly score: number;
}

interface ReactionRecord {
  readonly type: string;
  readonly value?: string | null;
}

/**
 * Dependencies injected by `reactionBuildAdapter` in `plugin.ts`.
 *
 * All adapter references are resolved lazily (called at request time, not at
 * factory creation time) so that circular dependency order during setupRoutes
 * does not cause runtime errors.
 */
export interface UpdateScoreDeps {
  /**
   * List all reactions for a target entity.
   * Returns `{ items: ReactionRecord[] }`.
   */
  readonly listReactions: (params: {
    targetId: string;
    targetType: string;
  }) => Promise<{ items: ReactionRecord[] }>;

  /**
   * Fetch the current state of the target entity (thread or reply).
   * Used to read `createdAt` for the `hot` algorithm.
   * Returns `null` if the entity cannot be resolved.
   */
  readonly fetchTarget: (params: {
    targetId: string;
    targetType: string;
  }) => Promise<{ createdAt?: string | Date } | null>;

  /**
   * Write the computed `score` and `reactionSummary` back to the target entity.
   */
  readonly updateTarget: (params: {
    targetId: string;
    targetType: string;
    score: number;
    reactionSummary: string;
  }) => Promise<void>;

  /** Frozen scoring configuration from the plugin config. */
  readonly scoring: ScoringConfig;
}

/**
 * Create the `updateScore` handler from the supplied dependencies.
 *
 * The returned function is injected onto the Reaction adapter by
 * `reactionBuildAdapter` in `plugin.ts`.
 *
 * @param deps - Lazily-resolved adapter accessors + frozen scoring config.
 * @returns An async handler `(params: UpdateScoreParams) => Promise<UpdateScoreResult>`.
 */
export function createUpdateScoreHandler(
  deps: UpdateScoreDeps,
): (params: UpdateScoreParams) => Promise<UpdateScoreResult> {
  return async params => {
    const { items: reactions } = await deps.listReactions({
      targetId: params.targetId,
      targetType: params.targetType,
    });

    // Aggregate reaction counts
    let upvotes = 0;
    let downvotes = 0;
    const emojiCounts: Record<string, number> = {};

    for (const reaction of reactions) {
      if (reaction.type === 'upvote') {
        upvotes++;
      } else if (reaction.type === 'downvote') {
        downvotes++;
      } else if (reaction.type === 'emoji' && reaction.value) {
        emojiCounts[reaction.value] = (emojiCounts[reaction.value] ?? 0) + 1;
      }
    }

    const net = computeNetScore(upvotes, downvotes, emojiCounts, deps.scoring);

    let score: number;
    const algorithm = deps.scoring.algorithm;

    if (algorithm === 'hot') {
      const target = await deps.fetchTarget({
        targetId: params.targetId,
        targetType: params.targetType,
      });
      const createdAtMs = target?.createdAt ? new Date(target.createdAt).getTime() : 0;
      score = computeHotScore(net, createdAtMs / 1000, deps.scoring.hotDecayHours);
    } else if (algorithm === 'controversial') {
      score = computeControversialScore(upvotes, downvotes, net);
    } else {
      // 'net' and 'top' both use the net score; time-window filtering for 'top'
      // is applied at list time in listByContainerSorted.
      score = net;
    }

    const reactionSummary = JSON.stringify({ upvotes, downvotes, emojis: emojiCounts });

    await deps.updateTarget({
      targetId: params.targetId,
      targetType: params.targetType,
      score,
      reactionSummary,
    });

    return { targetId: params.targetId, targetType: params.targetType, score };
  };
}

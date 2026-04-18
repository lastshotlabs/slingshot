/**
 * Pure scoring functions for the community ranking system.
 *
 * All functions are deterministic given their inputs and carry no side effects.
 * Algorithm selection happens at call-site based on `ScoringConfig.algorithm`;
 * see `src/operations/updateScore.ts` for the dispatch logic.
 *
 * Algorithms:
 * - **net** — weighted upvote/downvote tally + emoji bonus.
 * - **hot** — Reddit-style time-decaying hot score (log₁₀ + time offset).
 * - **top** — identical to net; the time-window filter is applied at list time.
 * - **controversial** — high total engagement ÷ low net (polarising content rises).
 */
import type { ScoringConfig } from '../types/config';

/**
 * Compute the net score for a reaction set.
 *
 * `net = upvotes * upvoteWeight - downvotes * downvoteWeight + Σ(emojiCount * emojiWeight)`
 *
 * @param upvotes - Number of upvote reactions.
 * @param downvotes - Number of downvote reactions.
 * @param emojiCounts - Map of emoji shortcode → count.
 * @param scoring - Frozen scoring config carrying weights.
 * @returns The numeric net score.
 */
export function computeNetScore(
  upvotes: number,
  downvotes: number,
  emojiCounts: Record<string, number>,
  scoring: Pick<ScoringConfig, 'upvoteWeight' | 'downvoteWeight' | 'emojiWeights'>,
): number {
  let score = upvotes * scoring.upvoteWeight - downvotes * scoring.downvoteWeight;
  for (const [emoji, count] of Object.entries(emojiCounts)) {
    score += count * (scoring.emojiWeights[emoji] ?? 0);
  }
  return score;
}

/**
 * Compute the Reddit-style hot score.
 *
 * `hot = log₁₀(max(|net|, 1)) * sign(net) + (createdAtEpochSeconds / (hotDecayHours * 3600))`
 *
 * The time offset term ensures newer content receives a small baseline bonus.
 * As `hotDecayHours` grows, the time bonus shrinks and older content decays
 * more slowly.
 *
 * @param net - Net score (from `computeNetScore`).
 * @param createdAtEpochSeconds - Unix timestamp (in seconds) of when the content was created.
 * @param hotDecayHours - Characteristic decay time in hours. Larger → slower decay.
 * @returns The hot score.
 */
export function computeHotScore(
  net: number,
  createdAtEpochSeconds: number,
  hotDecayHours: number,
): number {
  const order = Math.log10(Math.max(Math.abs(net), 1));
  const sign = net > 0 ? 1 : net < 0 ? -1 : 0;
  const seconds = hotDecayHours * 3600;
  return order * sign + createdAtEpochSeconds / seconds;
}

/**
 * Compute the controversial score.
 *
 * `controversial = (upvotes + downvotes) / max(|net|, 1)`
 *
 * High combined engagement divided by low net score surfaces polarising
 * content (roughly equal upvotes and downvotes). A pure upvote storm or
 * downvote storm both score low.
 *
 * @param upvotes - Number of upvote reactions.
 * @param downvotes - Number of downvote reactions.
 * @param net - Pre-computed net score.
 * @returns The controversial score.
 */
export function computeControversialScore(upvotes: number, downvotes: number, net: number): number {
  return (upvotes + downvotes) / Math.max(Math.abs(net), 1);
}

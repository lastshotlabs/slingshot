/**
 * Elimination scoring recipe.
 *
 * Utilities for eliminating players by score threshold or rank,
 * and checking for last-standing win conditions.
 *
 * See spec §23.2 for the API contract.
 */
import type { ProcessHandlerContext, WinResult } from '../types/models';

/** Options for eliminating the lowest scorers. */
export interface EliminateLowestOptions {
  /** Number of players to eliminate. */
  count: number;
  /** Player state to set on eliminated players. Default: 'eliminated'. */
  state?: string;
}

/** Options for eliminating below a threshold. */
export interface EliminateBelowOptions {
  /** Score threshold. Players at or below this are eliminated. */
  threshold: number;
  /** Player state to set on eliminated players. Default: 'eliminated'. */
  state?: string;
}

/**
 * Eliminate the N lowest-scoring players.
 *
 * Sets their player state to `'eliminated'` (or custom state).
 *
 * @returns Array of eliminated user IDs.
 */
function eliminateLowest(ctx: ProcessHandlerContext, options: EliminateLowestOptions): string[] {
  const state = options.state ?? 'eliminated';
  const leaderboard = ctx.getLeaderboard();

  // Sort ascending by score (lowest first)
  const sorted = [...leaderboard].sort((a, b) => a.score - b.score);

  const toEliminate = sorted.slice(0, options.count).filter(entry => {
    const player = ctx.getPlayer(entry.userId);
    return player.playerState !== state;
  });

  for (const entry of toEliminate) {
    ctx.setPlayerState(entry.userId, state);
  }

  return toEliminate.map(e => e.userId);
}

/**
 * Eliminate all players at or below a score threshold.
 *
 * @returns Array of eliminated user IDs.
 */
function eliminateBelow(ctx: ProcessHandlerContext, options: EliminateBelowOptions): string[] {
  const state = options.state ?? 'eliminated';
  const players = ctx.getPlayers();
  const eliminated: string[] = [];

  for (const player of players) {
    if (player.isSpectator || player.playerState === state) continue;
    const score = ctx.getScore(player.userId);
    if (score <= options.threshold) {
      ctx.setPlayerState(player.userId, state);
      eliminated.push(player.userId);
    }
  }

  return eliminated;
}

/**
 * Check if the game should end because one player or one team is last standing.
 *
 * @param eliminatedState - The state that marks a player as eliminated. Default: 'eliminated'.
 * @returns A `WinResult` if a winner exists, or `null` if the game continues.
 */
function checkLastStanding(ctx: ProcessHandlerContext, eliminatedState?: string): WinResult | null {
  const state = eliminatedState ?? 'eliminated';
  const players = ctx.getPlayers().filter(p => !p.isSpectator);
  const alive = players.filter(p => p.playerState !== state);

  if (alive.length === 0) {
    return {
      reason: 'All players eliminated',
      draw: true,
    };
  }

  if (alive.length === 1) {
    return {
      winners: [alive[0].userId],
      reason: 'Last player standing',
    };
  }

  // Check team-based last standing
  const aliveTeams = new Set(alive.map(p => p.team).filter(Boolean));
  if (aliveTeams.size === 1) {
    const winningTeam = [...aliveTeams][0];
    if (!winningTeam) return null;
    return {
      winningTeam,
      winners: alive.filter(p => p.team === winningTeam).map(p => p.userId),
      reason: 'Last team standing',
    };
  }

  return null;
}

export const elimination = {
  eliminateLowest,
  eliminateBelow,
  checkLastStanding,
};

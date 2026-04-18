/**
 * Scoring engine.
 *
 * Score mutations, leaderboard computation, team scoring, and streaks.
 * All mutations happen within the session mutex.
 *
 * See spec §15 for the full contract.
 */
import type { Leaderboard, ScoreEntry, ScoringDefinition, TeamScoreEntry } from '../types/models';

/** Mutable score state for an active session. */
export interface MutableScoreState {
  /** Per-player scores. */
  scores: Map<string, number>;

  /** Per-player score history (round → points). */
  history: Map<
    string,
    Array<{ round: number; points: number; breakdown?: Record<string, unknown> }>
  >;

  /** Per-player streak (consecutive correct/scoring events). */
  streaks: Map<string, number>;

  /** Per-player team membership. */
  teams: Map<string, string>;
}

/** Create initial score state. */
export function createScoreState(): MutableScoreState {
  return {
    scores: new Map(),
    history: new Map(),
    streaks: new Map(),
    teams: new Map(),
  };
}

/** Add points to a player's score. */
export function addScore(
  state: MutableScoreState,
  userId: string,
  points: number,
  round: number,
  breakdown?: Record<string, unknown>,
): void {
  const current = state.scores.get(userId) ?? 0;
  state.scores.set(userId, current + points);

  // Update history
  const playerHistory = state.history.get(userId) ?? [];
  playerHistory.push({ round, points, breakdown });
  state.history.set(userId, playerHistory);

  // Update streak
  if (points > 0) {
    const streak = state.streaks.get(userId) ?? 0;
    state.streaks.set(userId, streak + 1);
  } else {
    state.streaks.set(userId, 0);
  }
}

/** Set a player's score to an absolute value. */
export function setScore(state: MutableScoreState, userId: string, points: number): void {
  state.scores.set(userId, points);
}

/** Get a player's score. */
export function getScore(state: MutableScoreState, userId: string): number {
  return state.scores.get(userId) ?? 0;
}

/** Get a player's streak count. */
export function getPlayerStreak(state: MutableScoreState, userId: string): number {
  return state.streaks.get(userId) ?? 0;
}

/** Reset a player's streak (on wrong answer, etc.). */
export function resetStreak(state: MutableScoreState, userId: string): void {
  state.streaks.set(userId, 0);
}

/**
 * Compute the leaderboard sorted by score.
 *
 * @param direction - Sort direction. `'desc'` (default) = higher is better.
 */
export function computeLeaderboard(
  state: MutableScoreState,
  direction: 'desc' | 'asc' = 'desc',
): ScoreEntry[] {
  const entries: ScoreEntry[] = [];

  for (const [userId, score] of state.scores) {
    entries.push({ userId, score, rank: 0 });
  }

  entries.sort((a, b) => (direction === 'desc' ? b.score - a.score : a.score - b.score));

  // Assign ranks (handle ties — tied players get the same rank)
  let currentRank = 1;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && entries[i].score !== entries[i - 1].score) {
      currentRank = i + 1;
    }
    (entries[i] as { rank: number }).rank = currentRank;
  }

  return entries;
}

/** Compute team scores (sum of team members' scores). */
export function computeTeamScores(
  state: MutableScoreState,
  direction: 'desc' | 'asc' = 'desc',
): TeamScoreEntry[] {
  const teamScores = new Map<string, number>();

  for (const [userId, score] of state.scores) {
    const team = state.teams.get(userId);
    if (team) {
      teamScores.set(team, (teamScores.get(team) ?? 0) + score);
    }
  }

  const entries: TeamScoreEntry[] = [];
  for (const [team, score] of teamScores) {
    entries.push({ team, score, rank: 0 });
  }

  entries.sort((a, b) => (direction === 'desc' ? b.score - a.score : a.score - b.score));

  let currentRank = 1;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && entries[i].score !== entries[i - 1].score) {
      currentRank = i + 1;
    }
    (entries[i] as { rank: number }).rank = currentRank;
  }

  return entries;
}

/** Build a full leaderboard with optional team scores. */
export function buildLeaderboard(
  state: MutableScoreState,
  scoring: ScoringDefinition | null,
): Leaderboard {
  const direction = scoring?.display?.sortDirection ?? 'desc';
  const players = computeLeaderboard(state, direction);
  const teams = scoring?.teamScoring ? computeTeamScores(state, direction) : [];

  return { players, teams };
}

/** Register a player's team for team scoring. */
export function registerPlayerTeam(state: MutableScoreState, userId: string, team: string): void {
  state.teams.set(userId, team);
}

/** Initialize a player's score to 0. */
export function initializePlayerScore(state: MutableScoreState, userId: string): void {
  if (!state.scores.has(userId)) {
    state.scores.set(userId, 0);
    state.history.set(userId, []);
    state.streaks.set(userId, 0);
  }
}

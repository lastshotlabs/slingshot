/**
 * Unit tests for the scoring engine.
 *
 * Tests score addition, leaderboard computation, team aggregation,
 * streaks, and edge cases.
 */
import { describe, expect, test } from 'bun:test';
import {
  addScore,
  buildLeaderboard,
  computeLeaderboard,
  computeTeamScores,
  createScoreState,
  getPlayerStreak,
  getScore,
  initializePlayerScore,
  registerPlayerTeam,
  resetStreak,
  setScore,
} from '../../src/lib/scoring';

describe('createScoreState', () => {
  test('initializes with empty maps', () => {
    const state = createScoreState();
    expect(state.scores.size).toBe(0);
    expect(state.history.size).toBe(0);
    expect(state.streaks.size).toBe(0);
    expect(state.teams.size).toBe(0);
  });
});

describe('initializePlayerScore', () => {
  test('sets score to 0 for new player', () => {
    const state = createScoreState();
    initializePlayerScore(state, 'alice');
    expect(getScore(state, 'alice')).toBe(0);
    expect(state.history.get('alice')).toEqual([]);
    expect(state.streaks.get('alice')).toBe(0);
  });

  test('does not overwrite existing score', () => {
    const state = createScoreState();
    addScore(state, 'alice', 100, 1);
    initializePlayerScore(state, 'alice');
    expect(getScore(state, 'alice')).toBe(100);
  });
});

describe('addScore', () => {
  test('adds points to player score', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    expect(getScore(state, 'alice')).toBe(10);
  });

  test('accumulates multiple score additions', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    addScore(state, 'alice', 20, 2);
    expect(getScore(state, 'alice')).toBe(30);
  });

  test('records score history', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1, { bonus: true });
    addScore(state, 'alice', 5, 2);

    const history = state.history.get('alice');
    expect(history).toHaveLength(2);
    expect(history![0]).toEqual({ round: 1, points: 10, breakdown: { bonus: true } });
    expect(history![1]).toEqual({ round: 2, points: 5, breakdown: undefined });
  });

  test('increments streak on positive points', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    addScore(state, 'alice', 5, 2);
    expect(getPlayerStreak(state, 'alice')).toBe(2);
  });

  test('resets streak on zero points', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    addScore(state, 'alice', 0, 2);
    expect(getPlayerStreak(state, 'alice')).toBe(0);
  });

  test('handles negative points', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    addScore(state, 'alice', -5, 2);
    expect(getScore(state, 'alice')).toBe(5);
    expect(getPlayerStreak(state, 'alice')).toBe(0); // Negative resets streak
  });
});

describe('setScore', () => {
  test('sets absolute score value', () => {
    const state = createScoreState();
    setScore(state, 'alice', 42);
    expect(getScore(state, 'alice')).toBe(42);
  });

  test('overwrites existing score', () => {
    const state = createScoreState();
    addScore(state, 'alice', 100, 1);
    setScore(state, 'alice', 50);
    expect(getScore(state, 'alice')).toBe(50);
  });
});

describe('getScore', () => {
  test('returns 0 for unknown player', () => {
    const state = createScoreState();
    expect(getScore(state, 'unknown')).toBe(0);
  });
});

describe('resetStreak', () => {
  test('resets streak to 0', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);
    addScore(state, 'alice', 10, 2);
    expect(getPlayerStreak(state, 'alice')).toBe(2);
    resetStreak(state, 'alice');
    expect(getPlayerStreak(state, 'alice')).toBe(0);
  });
});

describe('computeLeaderboard', () => {
  test('sorts players by score descending', () => {
    const state = createScoreState();
    addScore(state, 'alice', 30, 1);
    addScore(state, 'bob', 50, 1);
    addScore(state, 'carol', 10, 1);

    const lb = computeLeaderboard(state);
    expect(lb[0].userId).toBe('bob');
    expect(lb[0].rank).toBe(1);
    expect(lb[1].userId).toBe('alice');
    expect(lb[1].rank).toBe(2);
    expect(lb[2].userId).toBe('carol');
    expect(lb[2].rank).toBe(3);
  });

  test('handles ties with same rank', () => {
    const state = createScoreState();
    addScore(state, 'alice', 20, 1);
    addScore(state, 'bob', 20, 1);
    addScore(state, 'carol', 10, 1);

    const lb = computeLeaderboard(state);
    expect(lb[0].rank).toBe(1);
    expect(lb[1].rank).toBe(1); // Tied
    expect(lb[2].rank).toBe(3); // Skips rank 2
  });

  test('supports ascending sort direction', () => {
    const state = createScoreState();
    addScore(state, 'alice', 30, 1);
    addScore(state, 'bob', 10, 1);

    const lb = computeLeaderboard(state, 'asc');
    expect(lb[0].userId).toBe('bob');
    expect(lb[1].userId).toBe('alice');
  });

  test('returns empty array for no players', () => {
    const state = createScoreState();
    expect(computeLeaderboard(state)).toEqual([]);
  });
});

describe('team scoring', () => {
  test('registerPlayerTeam records team membership', () => {
    const state = createScoreState();
    registerPlayerTeam(state, 'alice', 'red');
    expect(state.teams.get('alice')).toBe('red');
  });

  test('computeTeamScores aggregates team member scores', () => {
    const state = createScoreState();
    registerPlayerTeam(state, 'alice', 'red');
    registerPlayerTeam(state, 'bob', 'red');
    registerPlayerTeam(state, 'carol', 'blue');
    addScore(state, 'alice', 10, 1);
    addScore(state, 'bob', 20, 1);
    addScore(state, 'carol', 15, 1);

    const ts = computeTeamScores(state);
    expect(ts).toHaveLength(2);
    expect(ts[0].team).toBe('red');
    expect(ts[0].score).toBe(30);
    expect(ts[0].rank).toBe(1);
    expect(ts[1].team).toBe('blue');
    expect(ts[1].score).toBe(15);
    expect(ts[1].rank).toBe(2);
  });

  test('computeTeamScores handles ties', () => {
    const state = createScoreState();
    registerPlayerTeam(state, 'alice', 'red');
    registerPlayerTeam(state, 'bob', 'blue');
    addScore(state, 'alice', 10, 1);
    addScore(state, 'bob', 10, 1);

    const ts = computeTeamScores(state);
    expect(ts[0].rank).toBe(1);
    expect(ts[1].rank).toBe(1);
  });
});

describe('buildLeaderboard', () => {
  test('builds leaderboard with team scores when configured', () => {
    const state = createScoreState();
    registerPlayerTeam(state, 'alice', 'red');
    addScore(state, 'alice', 10, 1);

    const lb = buildLeaderboard(state, { teamScoring: true, display: { sortDirection: 'desc' } });
    expect(lb.players).toHaveLength(1);
    expect(lb.teams).toHaveLength(1);
  });

  test('builds leaderboard without team scores by default', () => {
    const state = createScoreState();
    addScore(state, 'alice', 10, 1);

    const lb = buildLeaderboard(state, null);
    expect(lb.players).toHaveLength(1);
    expect(lb.teams).toEqual([]);
  });
});

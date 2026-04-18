/**
 * Unit tests for the turn order manager.
 *
 * Tests createTurnState, advanceTurn, direction reversal, cycle detection,
 * skip mechanics, and turn order manipulation.
 */
import { describe, expect, test } from 'bun:test';
import {
  advanceTurn,
  completeTurnCycle,
  createTurnState,
  getActedPlayers,
  getRemainingPlayers,
  insertNextPlayer,
  isCycleComplete,
  reverseTurnOrder,
  rotateTurnStart,
  setActivePlayer,
  setTurnOrder,
  skipNextPlayer,
  skipPlayer,
} from '../../src/lib/turns';

describe('createTurnState', () => {
  test('initializes with correct defaults', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    expect(state.order).toEqual(['alice', 'bob', 'carol']);
    expect(state.activeIndex).toBe(0);
    expect(state.activePlayer).toBe('alice');
    expect(state.acted.size).toBe(0);
    expect(state.cycleCount).toBe(0);
    expect(state.direction).toBe(1);
  });

  test('handles empty player list', () => {
    const state = createTurnState([]);
    expect(state.order).toEqual([]);
    expect(state.activePlayer).toBeNull();
    expect(state.activeIndex).toBe(0);
  });

  test('returns mutable state (not readonly)', () => {
    const state = createTurnState(['alice']);
    state.activeIndex = 5;
    state.acted.add('alice');
    expect(state.activeIndex).toBe(5);
    expect(state.acted.has('alice')).toBeTrue();
  });
});

describe('advanceTurn', () => {
  test('advances to the next player', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    const next = advanceTurn(state);
    expect(next).toBe('bob');
    expect(state.activePlayer).toBe('bob');
    expect(state.activeIndex).toBe(1);
    expect(state.acted.has('alice')).toBeTrue();
  });

  test('wraps around at the end of the order', () => {
    const state = createTurnState(['alice', 'bob']);
    advanceTurn(state); // bob
    const next = advanceTurn(state); // wraps to alice
    expect(next).toBe('alice');
    expect(state.activeIndex).toBe(0);
    expect(state.cycleCount).toBe(1);
  });

  test('returns null for empty order', () => {
    const state = createTurnState([]);
    const result = advanceTurn(state);
    expect(result).toBeNull();
  });

  test('increments cycle count on wrap', () => {
    const state = createTurnState(['alice', 'bob']);
    advanceTurn(state); // bob
    advanceTurn(state); // wraps to alice, cycleCount = 1
    expect(state.cycleCount).toBe(1);
    advanceTurn(state); // bob
    advanceTurn(state); // wraps to alice, cycleCount = 2
    expect(state.cycleCount).toBe(2);
  });
});

describe('reverseTurnOrder', () => {
  test('reverses direction from forward to backward', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    expect(state.direction).toBe(1);
    reverseTurnOrder(state);
    expect(state.direction).toBe(-1);
  });

  test('backward direction wraps around', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    reverseTurnOrder(state);
    const next = advanceTurn(state); // Goes backward from index 0
    expect(next).toBe('carol');
    expect(state.activeIndex).toBe(2);
    expect(state.cycleCount).toBe(1); // Wrapped backward
  });

  test('double reverse restores original direction', () => {
    const state = createTurnState(['alice', 'bob']);
    reverseTurnOrder(state);
    reverseTurnOrder(state);
    expect(state.direction).toBe(1);
  });
});

describe('cycle detection', () => {
  test('isCycleComplete returns false when not all acted', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    state.acted.add('alice');
    expect(isCycleComplete(state)).toBeFalse();
  });

  test('isCycleComplete returns true when all acted', () => {
    const state = createTurnState(['alice', 'bob']);
    state.acted.add('alice');
    state.acted.add('bob');
    expect(isCycleComplete(state)).toBeTrue();
  });

  test('completeTurnCycle increments count and clears acted', () => {
    const state = createTurnState(['alice', 'bob']);
    state.acted.add('alice');
    completeTurnCycle(state);
    expect(state.cycleCount).toBe(1);
    expect(state.acted.size).toBe(0);
  });
});

describe('skip mechanics', () => {
  test('skipNextPlayer advances without marking acted', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    skipNextPlayer(state);
    expect(state.activePlayer).toBe('bob');
    expect(state.acted.has('alice')).toBeFalse();
  });

  test('skipPlayer marks a player as acted', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    skipPlayer(state, 'bob');
    expect(state.acted.has('bob')).toBeTrue();
  });
});

describe('turn order manipulation', () => {
  test('setTurnOrder replaces the order', () => {
    const state = createTurnState(['alice', 'bob']);
    setTurnOrder(state, ['carol', 'dave', 'eve']);
    expect(state.order).toEqual(['carol', 'dave', 'eve']);
    expect(state.activePlayer).toBe('carol');
    expect(state.activeIndex).toBe(0);
    expect(state.acted.size).toBe(0);
    expect(state.cycleCount).toBe(0);
  });

  test('setActivePlayer changes active player', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    setActivePlayer(state, 'carol');
    expect(state.activePlayer).toBe('carol');
    expect(state.activeIndex).toBe(2);
  });

  test('insertNextPlayer inserts into order', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    insertNextPlayer(state, 'dave');
    expect(state.order).toContain('dave');
    expect(state.order.length).toBe(4);
  });

  test('rotateTurnStart moves first player to end', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    rotateTurnStart(state);
    expect(state.order).toEqual(['bob', 'carol', 'alice']);
    expect(state.activePlayer).toBe('bob');
    expect(state.activeIndex).toBe(0);
  });
});

describe('query helpers', () => {
  test('getRemainingPlayers returns players who have not acted', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    state.acted.add('alice');
    expect(getRemainingPlayers(state)).toEqual(['bob', 'carol']);
  });

  test('getActedPlayers returns players who have acted', () => {
    const state = createTurnState(['alice', 'bob', 'carol']);
    state.acted.add('alice');
    state.acted.add('carol');
    expect(getActedPlayers(state)).toEqual(['alice', 'carol']);
  });
});

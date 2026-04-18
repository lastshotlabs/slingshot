/**
 * Turn order manager.
 *
 * Tracks turn ordering, active player, skip/timeout, and cycle detection.
 * Turn state is mutated in-place within the session mutex.
 *
 * See spec §9 for the full contract.
 */
import type { TurnState } from '../types/models';

/**
 * Create initial turn state from an ordered list of player IDs.
 *
 * Returns a {@link MutableTurnState} — the mutable internal representation.
 * Callers that need the read-only public view should use {@link freezeTurnState}.
 */
export function createTurnState(playerIds: string[]): MutableTurnState {
  return {
    order: [...playerIds],
    activeIndex: 0,
    activePlayer: playerIds.length > 0 ? playerIds[0] : null,
    acted: new Set<string>(),
    cycleCount: 0,
    direction: 1,
  };
}

/** Mutable turn state used internally. */
export interface MutableTurnState {
  order: string[];
  activeIndex: number;
  activePlayer: string | null;
  acted: Set<string>;
  cycleCount: number;
  direction: 1 | -1;
}

/** Advance to the next player in turn order. */
export function advanceTurn(state: MutableTurnState): string | null {
  if (state.order.length === 0) return null;

  // Mark current player as having acted
  if (state.activePlayer) {
    state.acted.add(state.activePlayer);
  }

  // Advance index
  state.activeIndex += state.direction;

  // Wrap around
  if (state.activeIndex >= state.order.length) {
    state.activeIndex = 0;
    state.cycleCount++;
  } else if (state.activeIndex < 0) {
    state.activeIndex = state.order.length - 1;
    state.cycleCount++;
  }

  state.activePlayer = state.order[state.activeIndex];
  return state.activePlayer;
}

/** Skip the next player without marking them as acted. */
export function skipNextPlayer(state: MutableTurnState): string | null {
  if (state.order.length <= 1) return state.activePlayer;

  const nextIndex = (state.activeIndex + state.direction + state.order.length) % state.order.length;
  state.activeIndex = nextIndex;
  state.activePlayer = state.order[state.activeIndex];
  return state.activePlayer;
}

/** Skip a specific player (remove from this cycle's order). */
export function skipPlayer(state: MutableTurnState, userId: string): void {
  state.acted.add(userId);
}

/** Insert a player as the next to act (for "extra turn" mechanics). */
export function insertNextPlayer(state: MutableTurnState, userId: string): void {
  const insertIndex =
    (state.activeIndex + state.direction + state.order.length) % state.order.length;
  state.order.splice(insertIndex, 0, userId);
}

/** Set a specific player as the active player. */
export function setActivePlayer(state: MutableTurnState, userId: string): void {
  const index = state.order.indexOf(userId);
  if (index !== -1) {
    state.activeIndex = index;
    state.activePlayer = userId;
  }
}

/** Reverse the turn direction (clockwise ↔ counter-clockwise). */
export function reverseTurnOrder(state: MutableTurnState): void {
  state.direction = state.direction === 1 ? -1 : 1;
}

/** Set a custom turn order. */
export function setTurnOrder(state: MutableTurnState, order: string[]): void {
  state.order = [...order];
  state.activeIndex = 0;
  state.activePlayer = order.length > 0 ? order[0] : null;
  state.acted.clear();
  state.cycleCount = 0;
}

/** Rotate the starting player (advance dealer position). */
export function rotateTurnStart(state: MutableTurnState): void {
  if (state.order.length <= 1) return;
  const first = state.order.shift();
  if (first === undefined) return;
  state.order.push(first);
  state.activeIndex = 0;
  state.activePlayer = state.order[0];
  state.acted.clear();
}

/** Mark the current turn cycle as complete. */
export function completeTurnCycle(state: MutableTurnState): void {
  state.cycleCount++;
  state.acted.clear();
}

/** Check if all players have acted in this cycle. */
export function isCycleComplete(state: MutableTurnState): boolean {
  return state.order.every(id => state.acted.has(id));
}

/** Get players who have not yet acted in this cycle. */
export function getRemainingPlayers(state: MutableTurnState): string[] {
  return state.order.filter(id => !state.acted.has(id));
}

/** Get players who have acted in this cycle. */
export function getActedPlayers(state: MutableTurnState): string[] {
  return state.order.filter(id => state.acted.has(id));
}

/** Freeze turn state to a read-only snapshot. */
export function freezeTurnState(state: MutableTurnState): TurnState {
  return {
    order: Object.freeze([...state.order]),
    activeIndex: state.activeIndex,
    activePlayer: state.activePlayer,
    acted: new Set(state.acted),
    cycleCount: state.cycleCount,
    direction: state.direction,
  };
}

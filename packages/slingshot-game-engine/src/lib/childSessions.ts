/**
 * Nested session management.
 *
 * Creates child sessions for mini-games (e.g., Mario Party), binds
 * their lifecycle to the parent, and propagates results back.
 *
 * See spec §22 for the full contract.
 */
import type { WinResult } from '../types/models';

/** Child session record tracked by the parent. */
export interface ChildSessionRecord {
  readonly sessionId: string;
  readonly gameType: string;
  readonly parentSessionId: string;
  readonly players: readonly string[];
  readonly createdAt: number;
  completedAt: number | null;
  result: WinResult | null;
}

/** Mutable child session tracking state. */
export interface MutableChildSessionState {
  /** Maps child sessionId to its record. */
  children: Map<string, ChildSessionRecord>;
}

/** Create initial child session state. */
export function createChildSessionState(): MutableChildSessionState {
  return {
    children: new Map(),
  };
}

/**
 * Register a newly created child session.
 */
export function registerChildSession(
  state: MutableChildSessionState,
  childSessionId: string,
  gameType: string,
  parentSessionId: string,
  players: string[],
): ChildSessionRecord {
  const record: ChildSessionRecord = {
    sessionId: childSessionId,
    gameType,
    parentSessionId,
    players: [...players],
    createdAt: Date.now(),
    completedAt: null,
    result: null,
  };

  state.children.set(childSessionId, record);
  return record;
}

/**
 * Record a child session's completion and its result.
 */
export function completeChildSession(
  state: MutableChildSessionState,
  childSessionId: string,
  result: WinResult,
): boolean {
  const record = state.children.get(childSessionId);
  if (!record) return false;

  record.completedAt = Date.now();
  record.result = result;
  return true;
}

/**
 * Get the result of a child session.
 *
 * @returns The `WinResult` if completed, `null` if still in progress,
 *          or `undefined` if the child session ID is not tracked.
 */
export function getChildSessionResult(
  state: MutableChildSessionState,
  childSessionId: string,
): WinResult | null | undefined {
  const record = state.children.get(childSessionId);
  if (!record) return undefined;
  return record.result;
}

/**
 * Get all active (uncompleted) child sessions.
 */
export function getActiveChildSessions(state: MutableChildSessionState): ChildSessionRecord[] {
  const active: ChildSessionRecord[] = [];
  for (const record of state.children.values()) {
    if (record.completedAt === null) {
      active.push(record);
    }
  }
  return active;
}

/**
 * Get all child session IDs for lifecycle binding.
 *
 * When the parent is paused/abandoned, all children must follow.
 */
export function getAllChildSessionIds(state: MutableChildSessionState): string[] {
  return [...state.children.keys()];
}

/**
 * Check if a session has any active child sessions.
 */
export function hasActiveChildren(state: MutableChildSessionState): boolean {
  for (const record of state.children.values()) {
    if (record.completedAt === null) return true;
  }
  return false;
}

/**
 * Remove a child session record.
 * Called during cleanup or when the child is no longer needed.
 */
export function removeChildSession(
  state: MutableChildSessionState,
  childSessionId: string,
): boolean {
  return state.children.delete(childSessionId);
}

/**
 * Remove all child session records.
 * Called when the parent session is cleaned up.
 */
export function clearChildSessions(state: MutableChildSessionState): void {
  state.children.clear();
}

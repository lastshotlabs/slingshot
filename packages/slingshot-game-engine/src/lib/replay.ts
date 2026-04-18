/**
 * Replay log.
 *
 * Append-only event log for deterministic state reconstruction.
 * Every input, phase transition, RNG call, and timer event is logged.
 *
 * See spec §20 for the full contract.
 */
import type { ReplayStore } from '../types/adapters';
import type { ReplayEntry, ReplayEventType } from '../types/models';

/** In-memory replay store (default implementation). */
export function createInMemoryReplayStore(): ReplayStore {
  const logs = new Map<string, ReplayEntry[]>();

  return {
    appendReplayEntries(sessionId: string, entries: ReplayEntry[]): Promise<void> {
      const existing = logs.get(sessionId) ?? [];
      existing.push(...entries);
      logs.set(sessionId, existing);
      return Promise.resolve();
    },

    getReplayEntries(
      sessionId: string,
      from: number,
      limit: number,
    ): Promise<{
      entries: ReplayEntry[];
      total: number;
      hasMore: boolean;
    }> {
      const all = logs.get(sessionId) ?? [];
      const filtered = all.filter(e => e.sequence > from);
      const entries = filtered.slice(0, limit);
      return Promise.resolve({
        entries,
        total: all.length,
        hasMore: filtered.length > limit,
      });
    },

    deleteReplayEntries(sessionId: string): Promise<void> {
      logs.delete(sessionId);
      return Promise.resolve();
    },
  };
}

/** Mutable sequence counter for a session's replay log. */
export interface ReplaySequence {
  next: number;
}

/** Create a new replay sequence counter. */
export function createReplaySequence(): ReplaySequence {
  return { next: 1 };
}

/**
 * Build replay entries from a processed input or event.
 *
 * This is a pure helper — it constructs `ReplayEntry` objects without
 * side effects. The caller is responsible for appending them to the
 * durable replay store.
 */
export function buildReplayEntry(
  sessionId: string,
  sequence: ReplaySequence,
  type: ReplayEventType,
  data: unknown,
): ReplayEntry {
  const entry: ReplayEntry = {
    id: `replay_${sessionId}_${sequence.next}`,
    sessionId,
    sequence: sequence.next,
    timestamp: Date.now(),
    type,
    data,
  };
  sequence.next++;
  return entry;
}

/**
 * Build multiple replay entries for a batch of events.
 */
export function buildReplayEntries(
  sessionId: string,
  sequence: ReplaySequence,
  events: Array<{ type: ReplayEventType; data: unknown }>,
): ReplayEntry[] {
  return events.map(({ type, data }) => buildReplayEntry(sessionId, sequence, type, data));
}

// ── Typed Instrumentation Helpers ──────────────────────────────────
//
// Each helper produces a ReplayEntry with a well-typed data shape.
// The orchestration layer calls these at the corresponding state-change
// points so the replay log captures all events with consistent structure.

/** Log session lifecycle events. */
export function logSessionCreated(
  sessionId: string,
  seq: ReplaySequence,
  data: { gameType: string; hostUserId: string; rules: Record<string, unknown> },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.created', data);
}

export function logSessionStarted(
  sessionId: string,
  seq: ReplaySequence,
  data: { playerCount: number; firstPhase: string | null },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.started', data);
}

export function logSessionCompleted(
  sessionId: string,
  seq: ReplaySequence,
  data: { result: { type: string; winners?: string[]; reason?: string } },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.completed', data);
}

export function logSessionAbandoned(
  sessionId: string,
  seq: ReplaySequence,
  data: { reason: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.abandoned', data);
}

export function logSessionPaused(
  sessionId: string,
  seq: ReplaySequence,
  data: { reason: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.paused', data);
}

export function logSessionResumed(sessionId: string, seq: ReplaySequence): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'session.resumed', {});
}

/** Log player events. */
export function logPlayerJoined(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; displayName: string; isSpectator: boolean },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.joined', data);
}

export function logPlayerLeft(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; reason: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.left', data);
}

export function logPlayerDisconnected(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; wasActivePlayer: boolean; gracePeriodMs: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.disconnected', data);
}

export function logPlayerReconnected(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; disconnectedForMs: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.reconnected', data);
}

export function logPlayerStateChanged(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; previousState: string | null; newState: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.stateChanged', data);
}

export function logPlayerReplaced(
  sessionId: string,
  seq: ReplaySequence,
  data: { oldUserId: string; newUserId: string; newDisplayName: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'player.replaced', data);
}

/** Log phase events. */
export function logPhaseEntered(
  sessionId: string,
  seq: ReplaySequence,
  data: { phase: string; timeout: number | null; channels: string[] },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'phase.entered', data);
}

export function logPhaseExited(
  sessionId: string,
  seq: ReplaySequence,
  data: { phase: string; reason: string; duration: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'phase.exited', data);
}

export function logSubPhaseEntered(
  sessionId: string,
  seq: ReplaySequence,
  data: { phase: string; subPhase: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'subPhase.entered', data);
}

export function logSubPhaseExited(
  sessionId: string,
  seq: ReplaySequence,
  data: { phase: string; subPhase: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'subPhase.exited', data);
}

/** Log channel events. */
export function logChannelOpened(
  sessionId: string,
  seq: ReplaySequence,
  data: { channel: string; mode: string; timeout: number | null },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'channel.opened', data);
}

export function logChannelClosed(
  sessionId: string,
  seq: ReplaySequence,
  data: { channel: string; reason: string; submissionCount: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'channel.closed', data);
}

export function logChannelInput(
  sessionId: string,
  seq: ReplaySequence,
  data: { channel: string; userId: string; input: unknown },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'channel.input', data);
}

export function logChannelRaceClaimed(
  sessionId: string,
  seq: ReplaySequence,
  data: { channel: string; userId: string; position: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'channel.race.claimed', data);
}

export function logChannelVoteTally(
  sessionId: string,
  seq: ReplaySequence,
  data: {
    channel: string;
    options: Record<string, number>;
    winner: string | null;
    tie: boolean;
    totalVotes: number;
  },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'channel.vote.tally', data);
}

/** Log turn events. */
export function logTurnAdvanced(
  sessionId: string,
  seq: ReplaySequence,
  data: { previousPlayer: string | null; nextPlayer: string; turnNumber: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'turn.advanced', data);
}

/** Log score events. */
export function logScoreChanged(
  sessionId: string,
  seq: ReplaySequence,
  data: { userId: string; previousScore: number; newScore: number; change: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'score.changed', data);
}

/** Log timer events. */
export function logTimerStarted(
  sessionId: string,
  seq: ReplaySequence,
  data: { timerId: string; type: string; durationMs: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'timer.started', data);
}

export function logTimerExpired(
  sessionId: string,
  seq: ReplaySequence,
  data: { timerId: string; type: string },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'timer.expired', data);
}

export function logTimerCancelled(
  sessionId: string,
  seq: ReplaySequence,
  data: { timerId: string; type: string; remainingMs: number },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'timer.cancelled', data);
}

/** Log state update events. */
export function logStateUpdated(
  sessionId: string,
  seq: ReplaySequence,
  data: { patches: Array<{ op: string; path: string; value?: unknown }> },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'state.updated', data);
}

/** Log RNG calls for deterministic replay. */
export function logRngCalled(
  sessionId: string,
  seq: ReplaySequence,
  data: { method: string; args: unknown[]; result: unknown },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'rng.called', data);
}

/** Log errors. */
export function logError(
  sessionId: string,
  seq: ReplaySequence,
  data: { code: string; message: string; context?: unknown },
): ReplayEntry {
  return buildReplayEntry(sessionId, seq, 'error', data);
}

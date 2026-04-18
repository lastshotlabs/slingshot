/**
 * Session cleanup and TTL-based garbage collection.
 *
 * Periodically sweeps for expired sessions based on configurable TTLs
 * for completed, abandoned, and idle lobby sessions. Optionally archives
 * session data (replay log, final state) before deletion.
 *
 * See spec §5.7 for the full contract.
 */
import type { SessionStatus } from '../types/models';

/** Cleanup configuration. */
export interface CleanupConfig {
  /** Time after completion before session data is deleted. Default: 4 hours. */
  readonly completedTtl: number;
  /** Time after last activity before an abandoned session is deleted. Default: 1 hour. */
  readonly abandonedTtl: number;
  /** Time a lobby can sit idle before cleanup. Default: 30 minutes. */
  readonly lobbyIdleTtl: number;
  /** How often to run the cleanup sweep. Default: 5 minutes. */
  readonly sweepInterval: number;
  /** Whether to archive session data before deletion. Default: false. */
  readonly archive: boolean;
}

/** Default cleanup config values. */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  completedTtl: 4 * 60 * 60 * 1000, // 4 hours
  abandonedTtl: 60 * 60 * 1000, // 1 hour
  lobbyIdleTtl: 30 * 60 * 1000, // 30 minutes
  sweepInterval: 5 * 60 * 1000, // 5 minutes
  archive: false,
};

/** Session record with the fields the cleanup sweep needs. */
export interface CleanupSessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly completedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
}

/** Callbacks for cleanup operations. */
export interface CleanupCallbacks {
  /**
   * Query sessions eligible for cleanup.
   * Returns sessions that are completed, abandoned, or idle lobbies.
   */
  querySessions(): Promise<CleanupSessionRecord[]>;

  /**
   * Delete a session and its associated data (players, replay entries).
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Archive a session before deletion (if `archive` is true).
   */
  archiveSession?(sessionId: string): Promise<void>;

  /** Optional logger. */
  log?: {
    info(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

/** Mutable cleanup state. */
export interface MutableCleanupState {
  config: CleanupConfig;
  handle: ReturnType<typeof setInterval> | null;
  running: boolean;
}

/** Create initial cleanup state. */
export function createCleanupState(config?: Partial<CleanupConfig>): MutableCleanupState {
  return {
    config: { ...DEFAULT_CLEANUP_CONFIG, ...config },
    handle: null,
    running: false,
  };
}

/**
 * Start the cleanup sweep timer.
 *
 * Runs periodically at `sweepInterval` to query and clean up
 * expired sessions.
 */
export function startCleanupSweep(state: MutableCleanupState, callbacks: CleanupCallbacks): void {
  if (state.running) return;

  state.running = true;
  state.handle = setInterval(() => runSweep(state, callbacks), state.config.sweepInterval);
}

/** Stop the cleanup sweep timer. */
export function stopCleanupSweep(state: MutableCleanupState): void {
  state.running = false;
  if (state.handle) {
    clearInterval(state.handle);
    state.handle = null;
  }
}

/**
 * Run a single cleanup sweep.
 *
 * Evaluates each session against its TTL based on status:
 * - `completed` → `completedTtl` after `completedAt`
 * - `abandoned` → `abandonedTtl` after `lastActivityAt`
 * - `lobby` → `lobbyIdleTtl` after `lastActivityAt` (or `createdAt`)
 *
 * Active sessions (`playing`, `starting`, `paused`) are never cleaned up.
 */
export async function runSweep(
  state: MutableCleanupState,
  callbacks: CleanupCallbacks,
): Promise<{ cleaned: number; errors: number }> {
  const now = Date.now();
  let cleaned = 0;
  let errors = 0;

  let sessions: CleanupSessionRecord[];
  try {
    sessions = await callbacks.querySessions();
  } catch (err) {
    callbacks.log?.error('Cleanup sweep failed to query sessions', err);
    return { cleaned: 0, errors: 1 };
  }

  for (const session of sessions) {
    const expired = isSessionExpired(session, state.config, now);
    if (!expired) continue;

    try {
      if (state.config.archive && callbacks.archiveSession) {
        await callbacks.archiveSession(session.id);
      }
      await callbacks.deleteSession(session.id);
      cleaned++;
      callbacks.log?.info(`Cleaned up session ${session.id} (status: ${session.status})`);
    } catch (err) {
      errors++;
      callbacks.log?.error(`Failed to clean up session ${session.id}`, err);
    }
  }

  return { cleaned, errors };
}

/**
 * Check if a session is past its TTL and should be cleaned up.
 */
export function isSessionExpired(
  session: CleanupSessionRecord,
  config: CleanupConfig,
  now: number,
): boolean {
  switch (session.status) {
    case 'completed': {
      if (!session.completedAt) return false;
      const completedAt = new Date(session.completedAt).getTime();
      return now - completedAt >= config.completedTtl;
    }
    case 'abandoned': {
      const lastActivity = session.lastActivityAt
        ? new Date(session.lastActivityAt).getTime()
        : new Date(session.createdAt).getTime();
      return now - lastActivity >= config.abandonedTtl;
    }
    case 'lobby': {
      const lastActivity = session.lastActivityAt
        ? new Date(session.lastActivityAt).getTime()
        : new Date(session.createdAt).getTime();
      return now - lastActivity >= config.lobbyIdleTtl;
    }
    // Active sessions are never cleaned up
    case 'playing':
    case 'starting':
    case 'paused':
      return false;
    default:
      return false;
  }
}

/**
 * Timer service.
 *
 * Server-authoritative timers for phases, channels, turns, and custom events.
 * Supports pause/resume, extend/cancel, and AFK detection.
 *
 * See spec §14 for the full contract.
 */
import type { GameTimer } from '../types/models';

/** Mutable timer state for an active session. */
export interface MutableTimerState {
  timers: Map<string, MutableTimer>;
  nextId: number;
}

/** Internal mutable timer representation. */
export interface MutableTimer {
  id: string;
  type: 'phase' | 'channel' | 'turn' | 'custom';
  sessionId: string;
  startedAt: number;
  duration: number;
  endsAt: number;
  pausedAt: number | null;
  remainingAtPause: number | null;
  callback: string;
  data?: unknown;
  handle: ReturnType<typeof setTimeout> | null;
}

/** Callback invoked when a timer fires. */
export type TimerCallback = (timer: GameTimer) => void | Promise<void>;

/** Create initial timer state. */
export function createTimerState(): MutableTimerState {
  return {
    timers: new Map(),
    nextId: 1,
  };
}

/**
 * Create and start a timer.
 *
 * @returns The timer ID.
 */
export function createTimer(
  state: MutableTimerState,
  sessionId: string,
  type: GameTimer['type'],
  durationMs: number,
  callback: string,
  onFire: TimerCallback,
  data?: unknown,
): string {
  const id = `timer_${state.nextId++}`;
  const now = Date.now();

  const timer: MutableTimer = {
    id,
    type,
    sessionId,
    startedAt: now,
    duration: durationMs,
    endsAt: now + durationMs,
    pausedAt: null,
    remainingAtPause: null,
    callback,
    data,
    handle: null,
  };

  timer.handle = setTimeout(() => {
    state.timers.delete(id);
    void onFire(freezeTimer(timer));
  }, durationMs);

  state.timers.set(id, timer);
  return id;
}

/** Cancel a timer. Returns true if the timer existed. */
export function cancelTimer(state: MutableTimerState, timerId: string): boolean {
  const timer = state.timers.get(timerId);
  if (!timer) return false;

  if (timer.handle) {
    clearTimeout(timer.handle);
  }
  state.timers.delete(timerId);
  return true;
}

/** Pause all active timers (preserving remaining time). */
export function pauseAllTimers(state: MutableTimerState): void {
  const now = Date.now();
  for (const timer of state.timers.values()) {
    if (timer.pausedAt === null && timer.handle) {
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.pausedAt = now;
      timer.remainingAtPause = Math.max(0, timer.endsAt - now);
    }
  }
}

/** Resume all paused timers with their remaining time. */
export function resumeAllTimers(state: MutableTimerState, onFire: TimerCallback): void {
  const now = Date.now();
  for (const timer of state.timers.values()) {
    if (timer.pausedAt !== null && timer.remainingAtPause !== null) {
      timer.endsAt = now + timer.remainingAtPause;
      timer.pausedAt = null;

      const remaining = timer.remainingAtPause;
      timer.remainingAtPause = null;

      timer.handle = setTimeout(() => {
        state.timers.delete(timer.id);
        void onFire(freezeTimer(timer));
      }, remaining);
    }
  }
}

/** Extend a timer by adding milliseconds. */
export function extendTimer(
  state: MutableTimerState,
  timerId: string,
  ms: number,
  onFire: TimerCallback,
): boolean {
  const timer = state.timers.get(timerId);
  if (!timer) return false;

  if (timer.pausedAt !== null) {
    // Timer is paused — just extend remaining
    timer.remainingAtPause = (timer.remainingAtPause ?? 0) + ms;
  } else {
    // Timer is running — cancel and restart with extended time
    if (timer.handle) clearTimeout(timer.handle);
    const remaining = Math.max(0, timer.endsAt - Date.now()) + ms;
    timer.endsAt = Date.now() + remaining;
    timer.handle = setTimeout(() => {
      state.timers.delete(timer.id);
      void onFire(freezeTimer(timer));
    }, remaining);
  }

  return true;
}

/** Reset a timer to a new duration. */
export function resetTimer(
  state: MutableTimerState,
  timerId: string,
  ms: number,
  onFire: TimerCallback,
): boolean {
  const timer = state.timers.get(timerId);
  if (!timer) return false;

  if (timer.handle) clearTimeout(timer.handle);
  timer.pausedAt = null;
  timer.remainingAtPause = null;

  const now = Date.now();
  timer.startedAt = now;
  timer.duration = ms;
  timer.endsAt = now + ms;

  timer.handle = setTimeout(() => {
    state.timers.delete(timer.id);
    void onFire(freezeTimer(timer));
  }, ms);

  return true;
}

/** Get time remaining on a timer (0 if expired or not found). */
export function getTimeRemaining(state: MutableTimerState, timerId: string): number {
  const timer = state.timers.get(timerId);
  if (!timer) return 0;
  if (timer.pausedAt !== null) return timer.remainingAtPause ?? 0;
  return Math.max(0, timer.endsAt - Date.now());
}

/** Cancel all timers (called during shutdown). */
export function cancelAllTimers(state: MutableTimerState): void {
  for (const timer of state.timers.values()) {
    if (timer.handle) clearTimeout(timer.handle);
  }
  state.timers.clear();
}

/** Get all active timers of a specific type. */
export function getTimersByType(state: MutableTimerState, type: GameTimer['type']): GameTimer[] {
  const result: GameTimer[] = [];
  for (const timer of state.timers.values()) {
    if (timer.type === type) {
      result.push(freezeTimer(timer));
    }
  }
  return result;
}

/** Freeze a mutable timer to a read-only snapshot. */
function freezeTimer(timer: MutableTimer): GameTimer {
  return {
    id: timer.id,
    type: timer.type,
    sessionId: timer.sessionId,
    startedAt: timer.startedAt,
    duration: timer.duration,
    endsAt: timer.endsAt,
    pausedAt: timer.pausedAt,
    remainingAtPause: timer.remainingAtPause,
    callback: timer.callback,
    data: timer.data,
  };
}

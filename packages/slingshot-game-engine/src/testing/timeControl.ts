/**
 * Deterministic time control for testing.
 *
 * Provides a mock clock that allows advancing time by exact
 * milliseconds or ticks, triggering timers deterministically.
 *
 * See spec §30.3 for the API contract.
 */

/** Scheduled timer tracked by the mock clock. */
interface ScheduledTimer {
  id: number;
  firesAt: number;
  callback: () => void;
  type: 'timeout' | 'interval';
  interval: number;
}

/** Mock clock for deterministic time control. */
export interface MockClock {
  /** Current mock time in milliseconds. */
  now(): number;

  /** Advance time by `ms` milliseconds, firing any due timers. */
  advance(ms: number): void;

  /** Schedule a timeout (replaces `setTimeout`). */
  setTimeout(callback: () => void, ms: number): number;

  /** Schedule an interval (replaces `setInterval`). */
  setInterval(callback: () => void, ms: number): number;

  /** Clear a timeout or interval. */
  clearTimeout(id: number): void;

  /** Clear a timeout or interval. */
  clearInterval(id: number): void;

  /** Reset the mock clock to zero. */
  reset(): void;

  /** Get the number of pending timers. */
  pendingCount(): number;
}

/**
 * Create a mock clock for deterministic testing.
 *
 * The clock starts at `startTime` (default: 0) and only advances
 * when `advance()` is called. Timers fire in chronological order
 * during advancement.
 */
export function createMockClock(startTime?: number): MockClock {
  let currentTime = startTime ?? 0;
  let nextId = 1;
  const timers = new Map<number, ScheduledTimer>();

  function now(): number {
    return currentTime;
  }

  function advance(ms: number): void {
    const targetTime = currentTime + ms;

    // Fire timers in order until we reach the target time
    for (;;) {
      let earliest: ScheduledTimer | null = null;
      for (const timer of timers.values()) {
        if (
          timer.firesAt <= targetTime &&
          (earliest === null || timer.firesAt < earliest.firesAt)
        ) {
          earliest = timer;
        }
      }

      if (!earliest) break;

      currentTime = earliest.firesAt;

      if (earliest.type === 'interval') {
        // Reschedule interval
        earliest.firesAt = currentTime + earliest.interval;
        earliest.callback();
      } else {
        // Remove timeout
        timers.delete(earliest.id);
        earliest.callback();
      }
    }

    currentTime = targetTime;
  }

  function mockSetTimeout(callback: () => void, ms: number): number {
    const id = nextId++;
    timers.set(id, {
      id,
      firesAt: currentTime + ms,
      callback,
      type: 'timeout',
      interval: ms,
    });
    return id;
  }

  function mockSetInterval(callback: () => void, ms: number): number {
    const id = nextId++;
    timers.set(id, {
      id,
      firesAt: currentTime + ms,
      callback,
      type: 'interval',
      interval: ms,
    });
    return id;
  }

  function mockClearTimeout(id: number): void {
    timers.delete(id);
  }

  function reset(): void {
    currentTime = startTime ?? 0;
    timers.clear();
    nextId = 1;
  }

  function pendingCount(): number {
    return timers.size;
  }

  return {
    now,
    advance,
    setTimeout: mockSetTimeout,
    setInterval: mockSetInterval,
    clearTimeout: mockClearTimeout,
    clearInterval: mockClearTimeout,
    reset,
    pendingCount,
  };
}

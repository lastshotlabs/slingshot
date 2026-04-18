/**
 * Game loop and tick system.
 *
 * Fixed-timestep server-side update cycle for real-time phases.
 * Handles input buffering, scheduled events, delta sync, and
 * tick overrun recovery.
 *
 * See spec §10 for the full contract.
 */
import type { BufferedInput, ScheduledEvent, SyncDefinition } from '../types/models';
import { deepCloneState, diffState } from './state';

/** Mutable game loop state for an active session. */
export interface MutableGameLoopState {
  running: boolean;
  tickRate: number;
  tick: number;
  startedAt: number;
  lastTickAt: number;
  effectiveTickRate: number;
  consecutiveOverruns: number;
  overrunStartedAt: number | null;
  maxOverrunMs: number;
  reducedRate: boolean;
  cleanTickCount: number;
  handle: ReturnType<typeof setTimeout> | null;

  /** Buffered inputs per channel. */
  inputBuffers: Map<string, BufferedInput[]>;

  /** Scheduled events keyed by ID. */
  scheduledEvents: Map<string, MutableScheduledEvent>;
  nextEventId: number;

  /** Previous state snapshot for delta diffing. */
  previousState: Record<string, unknown> | null;
}

/** Internal mutable scheduled event. */
export interface MutableScheduledEvent {
  id: string;
  type: string;
  data: unknown;
  scheduledAt: number;
  firesAtTick: number;
}

/** Tick handler callback invoked each tick. */
export type TickCallback = (
  tick: number,
  deltaTime: number,
  elapsedTime: number,
) => void | Promise<void>;

/** Delta sync callback invoked after each tick. */
export type DeltaSyncCallback = (
  tick: number,
  patches: Array<{ op: string; path: string; value?: unknown }>,
  fullSnapshot: boolean,
) => void;

/** Create initial game loop state. */
export function createGameLoopState(tickRate: number, maxOverrunMs?: number): MutableGameLoopState {
  return {
    running: false,
    tickRate,
    tick: 0,
    startedAt: 0,
    lastTickAt: 0,
    effectiveTickRate: tickRate,
    consecutiveOverruns: 0,
    overrunStartedAt: null,
    maxOverrunMs: maxOverrunMs ?? 5000,
    reducedRate: false,
    cleanTickCount: 0,
    handle: null,
    inputBuffers: new Map(),
    scheduledEvents: new Map(),
    nextEventId: 1,
    previousState: null,
  };
}

/**
 * Start the game loop.
 *
 * Runs a fixed-timestep tick at `(1000 / tickRate)` ms intervals.
 * Each tick: compute delta, consume scheduled events, invoke handler,
 * diff state (if delta sync), broadcast, increment counter.
 */
export function startGameLoop(
  state: MutableGameLoopState,
  onTick: TickCallback,
  gameState: Record<string, unknown>,
  sync: SyncDefinition,
  onDelta?: DeltaSyncCallback,
  onLog?: (level: string, message: string, data?: unknown) => void,
): void {
  if (state.running) return;

  state.running = true;
  state.startedAt = Date.now();
  state.lastTickAt = state.startedAt;
  state.tick = 0;
  state.previousState = sync.mode === 'delta' ? deepCloneState(gameState) : null;

  const scheduleNext = () => {
    if (!state.running) return;
    const interval = 1000 / state.effectiveTickRate;
    state.handle = setTimeout(
      () => runTick(state, onTick, gameState, sync, onDelta, onLog, scheduleNext),
      interval,
    );
  };

  scheduleNext();
}

/** Stop the game loop. */
export function stopGameLoop(state: MutableGameLoopState): void {
  state.running = false;
  if (state.handle) {
    clearTimeout(state.handle);
    state.handle = null;
  }
}

/** Pause the game loop (preserves state). */
export function pauseGameLoop(state: MutableGameLoopState): void {
  state.running = false;
  if (state.handle) {
    clearTimeout(state.handle);
    state.handle = null;
  }
}

/** Resume the game loop after a pause. */
export function resumeGameLoop(
  state: MutableGameLoopState,
  onTick: TickCallback,
  gameState: Record<string, unknown>,
  sync: SyncDefinition,
  onDelta?: DeltaSyncCallback,
  onLog?: (level: string, message: string, data?: unknown) => void,
): void {
  if (state.running) return;

  state.running = true;
  state.lastTickAt = Date.now();

  const scheduleNext = () => {
    if (!state.running) return;
    const interval = 1000 / state.effectiveTickRate;
    state.handle = setTimeout(
      () => runTick(state, onTick, gameState, sync, onDelta, onLog, scheduleNext),
      interval,
    );
  };

  scheduleNext();
}

/** Run a single tick. */
async function runTick(
  state: MutableGameLoopState,
  onTick: TickCallback,
  gameState: Record<string, unknown>,
  sync: SyncDefinition,
  onDelta: DeltaSyncCallback | undefined,
  onLog: ((level: string, message: string, data?: unknown) => void) | undefined,
  scheduleNext: () => void,
): Promise<void> {
  if (!state.running) return;

  const now = Date.now();
  const deltaTime = (now - state.lastTickAt) / 1000;
  const elapsedTime = (now - state.startedAt) / 1000;
  const tickStart = now;

  state.tick++;
  state.lastTickAt = now;

  try {
    await onTick(state.tick, deltaTime, elapsedTime);
  } catch (err) {
    onLog?.('error', `Tick ${state.tick} handler threw`, err);
  }

  // Delta sync: diff state and broadcast
  if (sync.mode === 'delta' && state.previousState && onDelta) {
    const fullSnapshotEvery = sync.fullSnapshotEvery ?? 0;
    const isFullSnapshot = fullSnapshotEvery > 0 && state.tick % fullSnapshotEvery === 0;

    if (isFullSnapshot) {
      onDelta(state.tick, [], true);
    } else {
      const patches = diffState(state.previousState, gameState);
      if (patches.length > 0) {
        onDelta(state.tick, patches, false);
      }
    }

    state.previousState = deepCloneState(gameState);
  } else if (sync.mode === 'snapshot' && onDelta) {
    onDelta(state.tick, [], true);
  }

  // Check for overrun
  const tickDuration = Date.now() - tickStart;
  const interval = 1000 / state.effectiveTickRate;

  if (tickDuration > interval) {
    state.consecutiveOverruns++;
    if (state.overrunStartedAt === null) {
      state.overrunStartedAt = now;
    }

    onLog?.('warn', `Tick ${state.tick} overrun: ${tickDuration}ms (budget: ${interval}ms)`);

    // Check if overruns exceed max threshold
    const overrunDuration = now - state.overrunStartedAt;
    if (overrunDuration > state.maxOverrunMs && !state.reducedRate) {
      state.effectiveTickRate = Math.max(1, Math.floor(state.tickRate / 2));
      state.reducedRate = true;
      state.cleanTickCount = 0;
      onLog?.(
        'error',
        `Reducing tick rate from ${state.tickRate} to ${state.effectiveTickRate} due to sustained overruns`,
      );
    }

    // Skip next tick to catch up
    scheduleNext();
    return;
  }

  // Track clean ticks for rate restoration
  state.consecutiveOverruns = 0;
  state.overrunStartedAt = null;

  if (state.reducedRate) {
    state.cleanTickCount++;
    if (state.cleanTickCount >= 60) {
      state.effectiveTickRate = state.tickRate;
      state.reducedRate = false;
      state.cleanTickCount = 0;
      onLog?.('info', `Restoring tick rate to ${state.tickRate} after 60 clean ticks`);
    }
  }

  scheduleNext();
}

// ── Input Buffering ──────────────────────────────────────────────

/**
 * Buffer an input for consumption in the next tick.
 * Used for channels with `buffer: true` during game loop phases.
 */
export function bufferInput(
  state: MutableGameLoopState,
  channel: string,
  userId: string,
  data: unknown,
  timestamp: number,
): void {
  let buffer = state.inputBuffers.get(channel);
  if (!buffer) {
    buffer = [];
    state.inputBuffers.set(channel, buffer);
  }
  buffer.push({ userId, data, timestamp });
}

/**
 * Consume all buffered inputs for a channel since the last tick.
 * Returns and clears the buffer.
 */
export function consumeBufferedInputs(
  state: MutableGameLoopState,
  channel: string,
): BufferedInput[] {
  const buffer = state.inputBuffers.get(channel);
  if (!buffer || buffer.length === 0) return [];
  const consumed = [...buffer];
  buffer.length = 0;
  return consumed;
}

// ── Scheduled Events ─────────────────────────────────────────────

/**
 * Schedule an event to fire after a delay (in ticks).
 *
 * @returns The event ID.
 */
export function scheduleEvent(
  state: MutableGameLoopState,
  delayTicks: number,
  type: string,
  data: unknown,
): string {
  const id = `evt_${state.nextEventId++}`;
  state.scheduledEvents.set(id, {
    id,
    type,
    data,
    scheduledAt: state.tick,
    firesAtTick: state.tick + delayTicks,
  });
  return id;
}

/** Cancel a scheduled event. */
export function cancelScheduledEvent(state: MutableGameLoopState, eventId: string): boolean {
  return state.scheduledEvents.delete(eventId);
}

/**
 * Get all pending scheduled events.
 */
export function getScheduledEvents(state: MutableGameLoopState): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];
  for (const evt of state.scheduledEvents.values()) {
    events.push({
      id: evt.id,
      type: evt.type,
      data: evt.data,
      firesAtTick: evt.firesAtTick,
    });
  }
  return events;
}

/**
 * Consume all scheduled events that are due (firesAtTick <= current tick).
 * Returns and removes them from the scheduled set.
 */
export function consumeScheduledEvents(state: MutableGameLoopState): ScheduledEvent[] {
  const due: ScheduledEvent[] = [];
  for (const [id, evt] of state.scheduledEvents) {
    if (evt.firesAtTick <= state.tick) {
      due.push({
        id: evt.id,
        type: evt.type,
        data: evt.data,
        firesAtTick: evt.firesAtTick,
      });
      state.scheduledEvents.delete(id);
    }
  }
  return due;
}

/** Clear all input buffers (called on loop stop). */
export function clearInputBuffers(state: MutableGameLoopState): void {
  for (const buffer of state.inputBuffers.values()) {
    buffer.length = 0;
  }
  state.inputBuffers.clear();
}

/** Clear all scheduled events (called on loop stop). */
export function clearScheduledEvents(state: MutableGameLoopState): void {
  state.scheduledEvents.clear();
}

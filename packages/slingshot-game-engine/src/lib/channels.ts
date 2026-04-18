/**
 * Channel system.
 *
 * Runtime implementation for all 6 channel modes: collect, race, stream,
 * turn, vote, free. Each mode has distinct submission tracking and
 * completion semantics.
 *
 * Stream mode includes sliding-window rate limiting, per-player ring
 * buffers for tick consumption (`buffer: true`), circular persistence
 * buffers for reconnection replay, and dynamic relay re-evaluation.
 *
 * See spec §8 for the full contract.
 */
import type {
  BufferedInput,
  ChannelDefinition,
  ChannelMode,
  ChannelRuntimeState,
  ReadonlyHandlerContext,
} from '../types/models';

/** Single entry in a stream persistence circular buffer. */
export interface StreamPersistEntry {
  readonly userId: string;
  readonly data: unknown;
  readonly timestamp: number;
}

/** Per-player sliding window rate limit tracker for stream channels. */
export interface StreamRateLimitState {
  /** Per-player timestamp arrays for sliding window. */
  windows: Map<string, number[]>;
  /** Max messages per window. */
  max: number;
  /** Window duration in ms. */
  per: number;
}

/** Mutable channel runtime state. */
export interface MutableChannelState {
  name: string;
  mode: ChannelMode;
  definition: ChannelDefinition;
  open: boolean;
  startedAt: number;
  endsAt: number | null;
  submissions: Map<string, { input: unknown; submittedAt: number }>;
  claimedBy: string[];
  complete: boolean;
  timerId: string | null;

  // ── Stream mode extensions ──
  /** Per-player input buffers for `buffer: true` stream channels. */
  streamBuffers: Map<string, BufferedInput[]> | null;
  /** Circular persistence buffer for reconnection replay. */
  persistBuffer: StreamPersistEntry[] | null;
  /** Max entries in the persistence buffer. */
  persistMaxCount: number;
  /** Per-player rate limit state for stream channels. */
  streamRateLimit: StreamRateLimitState | null;
}

/** Default stream rate limit: 30 messages per second. */
const DEFAULT_STREAM_RATE_LIMIT = { max: 30, per: 1000 };

/** Default persist buffer max count. */
const DEFAULT_PERSIST_MAX_COUNT = 200;

/** Create initial channel state from a definition. */
export function createChannelState(
  name: string,
  definition: ChannelDefinition,
  ctx: ReadonlyHandlerContext,
): MutableChannelState {
  const timeout =
    typeof definition.timeout === 'function' ? definition.timeout(ctx) : definition.timeout;

  const now = Date.now();

  // Stream mode extensions
  let streamBuffers: Map<string, BufferedInput[]> | null = null;
  let persistBuffer: StreamPersistEntry[] | null = null;
  let persistMaxCount = 0;
  let streamRateLimit: StreamRateLimitState | null = null;

  if (definition.mode === 'stream') {
    // Buffer mode — per-player ring buffers for tick consumption
    if (definition.buffer) {
      streamBuffers = new Map();
    }

    // Persist mode — circular buffer for reconnection replay
    if (definition.persist) {
      const maxCount =
        typeof definition.persist === 'object' && definition.persist.maxCount
          ? definition.persist.maxCount
          : DEFAULT_PERSIST_MAX_COUNT;
      persistBuffer = [];
      persistMaxCount = maxCount;
    }

    // Rate limiting — always active on stream channels
    const rl = definition.rateLimit ?? DEFAULT_STREAM_RATE_LIMIT;
    streamRateLimit = {
      windows: new Map(),
      max: rl.max,
      per: rl.per,
    };
  }

  return {
    name,
    mode: definition.mode,
    definition,
    open: true,
    startedAt: now,
    endsAt: timeout ? now + timeout : null,
    submissions: new Map(),
    claimedBy: [],
    complete: false,
    timerId: null,
    streamBuffers,
    persistBuffer,
    persistMaxCount,
    streamRateLimit,
  };
}

/**
 * Record a submission on a channel.
 *
 * @returns An object indicating whether to accept, relay, and/or complete.
 */
export function recordSubmission(
  state: MutableChannelState,
  userId: string,
  input: unknown,
  eligiblePlayerIds: string[],
): {
  accepted: boolean;
  code?: string;
  shouldRelay: boolean;
  shouldComplete: boolean;
  previousInput?: unknown;
} {
  if (!state.open || state.complete) {
    return { accepted: false, code: 'CHANNEL_NOT_OPEN', shouldRelay: false, shouldComplete: false };
  }

  switch (state.mode) {
    case 'collect':
      return recordCollect(state, userId, input, eligiblePlayerIds);
    case 'race':
      return recordRace(state, userId, input);
    case 'stream':
      return recordStream(state, userId, input);
    case 'turn':
      return recordTurn(state, userId, input);
    case 'vote':
      return recordVote(state, userId, input, eligiblePlayerIds);
    case 'free':
      return recordFree(state, userId, input);
  }
}

function recordCollect(
  state: MutableChannelState,
  userId: string,
  input: unknown,
  eligiblePlayerIds: string[],
): ReturnType<typeof recordSubmission> {
  const existing = state.submissions.get(userId);
  const allowChange = state.definition.allowChange ?? false;

  if (existing && !allowChange) {
    return {
      accepted: false,
      code: 'INPUT_ALREADY_SUBMITTED',
      shouldRelay: false,
      shouldComplete: false,
    };
  }

  const previousInput = existing?.input;
  state.submissions.set(userId, { input, submittedAt: Date.now() });

  // Check if all eligible players have submitted
  const allSubmitted = eligiblePlayerIds.every(id => state.submissions.has(id));
  const shouldComplete = allSubmitted && !allowChange;

  const revealMode = state.definition.revealMode ?? 'after-close';
  const shouldRelay = revealMode === 'immediate';

  return {
    accepted: true,
    shouldRelay,
    shouldComplete,
    previousInput: existing ? previousInput : undefined,
  };
}

function recordRace(
  state: MutableChannelState,
  userId: string,
  _input: unknown,
): ReturnType<typeof recordSubmission> {
  const maxClaimed =
    typeof state.definition.count === 'function' ? 1 : (state.definition.count ?? 1);

  if (state.claimedBy.length >= maxClaimed) {
    return {
      accepted: false,
      code: 'INPUT_RACE_ALREADY_CLAIMED',
      shouldRelay: false,
      shouldComplete: false,
    };
  }

  state.claimedBy.push(userId);
  state.submissions.set(userId, { input: _input, submittedAt: Date.now() });

  const shouldComplete = state.claimedBy.length >= maxClaimed;

  return { accepted: true, shouldRelay: true, shouldComplete };
}

function recordStream(
  state: MutableChannelState,
  userId: string,
  input: unknown,
): ReturnType<typeof recordSubmission> {
  const now = Date.now();

  // Rate limit check — silently drop excess messages (no error sent)
  if (state.streamRateLimit) {
    const rl = state.streamRateLimit;
    let timestamps = rl.windows.get(userId);
    if (!timestamps) {
      timestamps = [];
      rl.windows.set(userId, timestamps);
    }

    // Remove expired timestamps outside the window
    const windowStart = now - rl.per;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= rl.max) {
      // Silently drop — spec says no error sent for stream rate limit
      return {
        accepted: false,
        code: 'INPUT_RATE_LIMITED',
        shouldRelay: false,
        shouldComplete: false,
      };
    }

    timestamps.push(now);
  }

  state.submissions.set(userId, { input, submittedAt: now });

  // Buffer mode — queue for tick consumption instead of immediate relay
  if (state.streamBuffers) {
    let buffer = state.streamBuffers.get(userId);
    if (!buffer) {
      buffer = [];
      state.streamBuffers.set(userId, buffer);
    }
    buffer.push({ userId, data: input, timestamp: now });
    // In buffer mode, inputs are consumed by tick handler — do NOT relay
    return { accepted: true, shouldRelay: false, shouldComplete: false };
  }

  // Persist mode — add to circular buffer for reconnection replay
  if (state.persistBuffer) {
    state.persistBuffer.push({ userId, data: input, timestamp: now });
    // Evict oldest entries when exceeding max count
    while (state.persistBuffer.length > state.persistMaxCount) {
      state.persistBuffer.shift();
    }
  }

  return { accepted: true, shouldRelay: true, shouldComplete: false };
}

function recordTurn(
  state: MutableChannelState,
  userId: string,
  input: unknown,
): ReturnType<typeof recordSubmission> {
  // Turn validation (is it this player's turn?) is handled upstream
  // in the input pipeline. Here we just record the submission.
  state.submissions.set(userId, { input, submittedAt: Date.now() });
  return { accepted: true, shouldRelay: true, shouldComplete: false };
}

function recordVote(
  state: MutableChannelState,
  userId: string,
  input: unknown,
  eligiblePlayerIds: string[],
): ReturnType<typeof recordSubmission> {
  const existing = state.submissions.get(userId);
  const allowChange = state.definition.allowChange ?? false;

  if (existing && !allowChange) {
    return {
      accepted: false,
      code: 'INPUT_ALREADY_SUBMITTED',
      shouldRelay: false,
      shouldComplete: false,
    };
  }

  state.submissions.set(userId, { input, submittedAt: Date.now() });

  const allVoted = eligiblePlayerIds.every(id => state.submissions.has(id));

  const revealMode = state.definition.revealMode ?? 'after-close';
  const shouldRelay = revealMode === 'immediate';

  return { accepted: true, shouldRelay, shouldComplete: allVoted };
}

function recordFree(
  state: MutableChannelState,
  userId: string,
  input: unknown,
): ReturnType<typeof recordSubmission> {
  state.submissions.set(userId, { input, submittedAt: Date.now() });
  return { accepted: true, shouldRelay: true, shouldComplete: false };
}

/** Close a channel. No further submissions accepted. */
export function closeChannel(state: MutableChannelState): void {
  state.open = false;
  state.complete = true;
}

/** Check if a channel is complete. */
export function isChannelComplete(state: MutableChannelState): boolean {
  return state.complete;
}

/** Freeze a mutable channel state to a read-only snapshot. */
export function freezeChannelState(state: MutableChannelState): ChannelRuntimeState {
  return {
    name: state.name,
    mode: state.mode,
    open: state.open,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    submissions: new Map(state.submissions),
    claimedBy: [...state.claimedBy],
    complete: state.complete,
  };
}

/**
 * Consume all buffered stream inputs for a channel.
 *
 * Returns and clears per-player buffers. Used by tick handlers
 * when the channel has `buffer: true`.
 */
export function consumeStreamBuffers(state: MutableChannelState): BufferedInput[] {
  if (!state.streamBuffers) return [];

  const all: BufferedInput[] = [];
  for (const buffer of state.streamBuffers.values()) {
    all.push(...buffer);
    buffer.length = 0;
  }

  // Sort by timestamp for deterministic processing order
  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}

/**
 * Get persisted stream entries for reconnection replay.
 *
 * Returns entries after the given timestamp (exclusive), up to a limit.
 */
export function getPersistedStreamEntries(
  state: MutableChannelState,
  afterTimestamp: number,
  limit?: number,
): StreamPersistEntry[] {
  if (!state.persistBuffer) return [];

  const filtered = state.persistBuffer.filter(e => e.timestamp > afterTimestamp);
  return limit ? filtered.slice(0, limit) : filtered;
}

/**
 * Check if a stream channel uses dynamic relay (re-evaluate per message).
 *
 * Dynamic relay is implicit when `relay` is `'custom'`, or explicit
 * via the `dynamicRelay` flag.
 */
export function isStreamDynamicRelay(definition: ChannelDefinition): boolean {
  if (definition.relay === 'custom') return true;
  return definition.dynamicRelay === true;
}

/**
 * Compute vote tally from a vote channel's submissions.
 */
export function computeVoteTally(state: MutableChannelState): {
  options: Map<string, number>;
  winner: string | null;
  tie: boolean;
  totalVotes: number;
  votes: Map<string, string>;
} {
  const optionCounts = new Map<string, number>();
  const votes = new Map<string, string>();

  for (const [userId, { input }] of state.submissions) {
    const vote = String(input);
    votes.set(userId, vote);
    optionCounts.set(vote, (optionCounts.get(vote) ?? 0) + 1);
  }

  let maxCount = 0;
  let winner: string | null = null;
  let tie = false;

  for (const [option, count] of optionCounts) {
    if (count > maxCount) {
      maxCount = count;
      winner = option;
      tie = false;
    } else if (count === maxCount) {
      tie = true;
    }
  }

  return {
    options: optionCounts,
    winner: tie ? null : winner,
    tie,
    totalVotes: state.submissions.size,
    votes,
  };
}

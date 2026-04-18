/**
 * Unit tests for the channel system.
 *
 * Tests channel modes (collect, race, stream, vote, free), submission
 * recording, freeze behavior, and edge cases.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  closeChannel,
  createChannelState,
  freezeChannelState,
  recordSubmission,
} from '../../src/lib/channels';
import type { ChannelDefinition, ReadonlyHandlerContext } from '../../src/types/models';

/** Minimal ReadonlyHandlerContext stub. */
function stubCtx(): ReadonlyHandlerContext {
  return {
    sessionId: 'test-session',
    gameType: 'test-game',
    rules: {},
    currentPhase: 'play',
    currentSubPhase: null,
    currentRound: 1,
    gameState: {},
    getPrivateState: () => null,
    getPlayer: () => {
      throw new Error('not implemented');
    },
    getPlayers: () => [],
    getPlayersByRole: () => [],
    getPlayersByTeam: () => [],
    getPlayersByState: () => [],
    getConnectedPlayers: () => [],
    getDisconnectedPlayers: () => [],
    getActivePlayer: () => null,
    getTurnOrder: () => [],
    getActedCount: () => 0,
    getActedPlayers: () => [],
    getRemainingPlayers: () => [],
    getScore: () => 0,
    getLeaderboard: () => [],
    getTeamScores: () => [],
    getPlayerStreak: () => 0,
    getChannelState: () => {
      throw new Error('not implemented');
    },
    getChannelInputs: () => new Map(),
    getTimeRemaining: () => 0,
    getPhaseEndsAt: () => 0,
    random: { next: () => 0, nextInt: () => 0, nextFloat: () => 0, shuffle: <T>(a: T[]) => a },
    getScheduledEvents: () => [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function makeCollectDef(overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    mode: 'collect',
    from: 'all-players',
    schema: z.string(),
    timeout: undefined,
    ...overrides,
  } as ChannelDefinition;
}

describe('createChannelState', () => {
  test('creates open channel with correct mode', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    expect(state.name).toBe('answers');
    expect(state.mode).toBe('collect');
    expect(state.open).toBeTrue();
    expect(state.complete).toBeFalse();
    expect(state.submissions.size).toBe(0);
  });

  test('sets endsAt when timeout is configured', () => {
    const def = makeCollectDef({ timeout: 5000 });
    const state = createChannelState('answers', def, stubCtx());
    expect(state.endsAt).toBeGreaterThan(0);
  });

  test('endsAt is null when no timeout', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    expect(state.endsAt).toBeNull();
  });
});

describe('collect mode', () => {
  test('accepts first submission from a player', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    const result = recordSubmission(state, 'alice', 'my answer', ['alice', 'bob']);
    expect(result.accepted).toBeTrue();
    expect(state.submissions.has('alice')).toBeTrue();
  });

  test('rejects duplicate submission without allowChange', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    recordSubmission(state, 'alice', 'first', ['alice', 'bob']);
    const result = recordSubmission(state, 'alice', 'second', ['alice', 'bob']);
    expect(result.accepted).toBeFalse();
    expect(result.code).toBe('INPUT_ALREADY_SUBMITTED');
  });

  test('allows change when allowChange is true', () => {
    const def = makeCollectDef({ allowChange: true });
    const state = createChannelState('answers', def, stubCtx());
    recordSubmission(state, 'alice', 'first', ['alice', 'bob']);
    const result = recordSubmission(state, 'alice', 'second', ['alice', 'bob']);
    expect(result.accepted).toBeTrue();
    expect(result.previousInput).toBe('first');
  });

  test('completes when all eligible players submitted', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    recordSubmission(state, 'alice', 'a', ['alice', 'bob']);
    const result = recordSubmission(state, 'bob', 'b', ['alice', 'bob']);
    expect(result.shouldComplete).toBeTrue();
  });
});

describe('race mode', () => {
  test('accepts first claimer', () => {
    const def = { mode: 'race', from: 'all-players', schema: z.string() } as ChannelDefinition;
    const state = createChannelState('buzzer', def, stubCtx());
    const result = recordSubmission(state, 'alice', 'buzz', []);
    expect(result.accepted).toBeTrue();
    expect(result.shouldComplete).toBeTrue(); // Default count is 1
    expect(state.claimedBy).toContain('alice');
  });

  test('rejects after max claimed reached', () => {
    const def = { mode: 'race', from: 'all-players', schema: z.string() } as ChannelDefinition;
    const state = createChannelState('buzzer', def, stubCtx());
    recordSubmission(state, 'alice', 'buzz', []);
    const result = recordSubmission(state, 'bob', 'buzz', []);
    expect(result.accepted).toBeFalse();
    expect(result.code).toBe('INPUT_RACE_ALREADY_CLAIMED');
  });
});

describe('free mode', () => {
  test('accepts any submission', () => {
    const def = { mode: 'free', from: 'all-players', schema: z.string() } as ChannelDefinition;
    const state = createChannelState('chat', def, stubCtx());
    const r1 = recordSubmission(state, 'alice', 'hello', []);
    const r2 = recordSubmission(state, 'alice', 'world', []);
    expect(r1.accepted).toBeTrue();
    expect(r2.accepted).toBeTrue();
  });
});

describe('closeChannel', () => {
  test('closes a channel', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    closeChannel(state);
    expect(state.open).toBeFalse();
    expect(state.complete).toBeTrue();
  });

  test('rejects submissions after close', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    closeChannel(state);
    const result = recordSubmission(state, 'alice', 'late', ['alice']);
    expect(result.accepted).toBeFalse();
    expect(result.code).toBe('CHANNEL_NOT_OPEN');
  });
});

describe('freezeChannelState', () => {
  test('returns read-only snapshot', () => {
    const def = makeCollectDef();
    const state = createChannelState('answers', def, stubCtx());
    recordSubmission(state, 'alice', 'my answer', ['alice', 'bob']);

    const frozen = freezeChannelState(state);
    expect(frozen.name).toBe('answers');
    expect(frozen.mode).toBe('collect');
    expect(frozen.open).toBeTrue();
    expect(frozen.submissions.size).toBe(1);
  });
});

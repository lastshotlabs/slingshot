/**
 * Unit tests for the input pipeline.
 *
 * Tests isAuthorizedForChannel, rejectInput, acceptInput, and validateInput.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { GameErrorCode } from '../../src/errors';
import {
  acceptInput,
  isAuthorizedForChannel,
  rejectInput,
  validateInput,
} from '../../src/lib/input';
import type {
  ChannelDefinition,
  GamePlayerState,
  ReadonlyHandlerContext,
} from '../../src/types/models';

/** Minimal player stub. */
function makePlayer(overrides: Partial<GamePlayerState> = {}): GamePlayerState {
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: false,
    isSpectator: false,
    joinOrder: 0,
    ...overrides,
  };
}

/** Minimal ReadonlyHandlerContext stub. */
function stubCtx(overrides: Partial<ReadonlyHandlerContext> = {}): ReadonlyHandlerContext {
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
    ...overrides,
  };
}

describe('isAuthorizedForChannel', () => {
  describe('all-players', () => {
    test('allows non-spectator players', () => {
      const player = makePlayer({ isSpectator: false });
      expect(isAuthorizedForChannel('all-players', 'alice', player, null, stubCtx())).toBeTrue();
    });

    test('rejects spectators', () => {
      const player = makePlayer({ isSpectator: true });
      expect(isAuthorizedForChannel('all-players', 'alice', player, null, stubCtx())).toBeFalse();
    });
  });

  describe('active-player', () => {
    test('allows the active player', () => {
      const player = makePlayer();
      expect(
        isAuthorizedForChannel('active-player', 'alice', player, 'alice', stubCtx()),
      ).toBeTrue();
    });

    test('rejects non-active player', () => {
      const player = makePlayer();
      expect(
        isAuthorizedForChannel('active-player', 'alice', player, 'bob', stubCtx()),
      ).toBeFalse();
    });
  });

  describe('other-players', () => {
    test('allows non-active, non-spectator players', () => {
      const player = makePlayer({ isSpectator: false });
      expect(isAuthorizedForChannel('other-players', 'alice', player, 'bob', stubCtx())).toBeTrue();
    });

    test('rejects the active player', () => {
      const player = makePlayer();
      expect(
        isAuthorizedForChannel('other-players', 'alice', player, 'alice', stubCtx()),
      ).toBeFalse();
    });

    test('rejects spectators', () => {
      const player = makePlayer({ isSpectator: true });
      expect(
        isAuthorizedForChannel('other-players', 'alice', player, 'bob', stubCtx()),
      ).toBeFalse();
    });
  });

  describe('host', () => {
    test('allows host player', () => {
      const player = makePlayer({ isHost: true });
      expect(isAuthorizedForChannel('host', 'alice', player, null, stubCtx())).toBeTrue();
    });

    test('rejects non-host player', () => {
      const player = makePlayer({ isHost: false });
      expect(isAuthorizedForChannel('host', 'alice', player, null, stubCtx())).toBeFalse();
    });
  });

  describe('role-based', () => {
    test('allows matching role', () => {
      const player = makePlayer({ role: 'drawer' });
      expect(
        isAuthorizedForChannel({ role: 'drawer' }, 'alice', player, null, stubCtx()),
      ).toBeTrue();
    });

    test('rejects non-matching role', () => {
      const player = makePlayer({ role: 'guesser' });
      expect(
        isAuthorizedForChannel({ role: 'drawer' }, 'alice', player, null, stubCtx()),
      ).toBeFalse();
    });
  });

  describe('state-based', () => {
    test('allows matching state string', () => {
      const player = makePlayer({ playerState: 'alive' });
      expect(
        isAuthorizedForChannel({ state: 'alive' }, 'alice', player, null, stubCtx()),
      ).toBeTrue();
    });

    test('rejects non-matching state', () => {
      const player = makePlayer({ playerState: 'dead' });
      expect(
        isAuthorizedForChannel({ state: 'alive' }, 'alice', player, null, stubCtx()),
      ).toBeFalse();
    });

    test('allows matching state from array', () => {
      const player = makePlayer({ playerState: 'active' });
      expect(
        isAuthorizedForChannel({ state: ['active', 'ready'] }, 'alice', player, null, stubCtx()),
      ).toBeTrue();
    });

    test('rejects state not in array', () => {
      const player = makePlayer({ playerState: 'dead' });
      expect(
        isAuthorizedForChannel({ state: ['active', 'ready'] }, 'alice', player, null, stubCtx()),
      ).toBeFalse();
    });
  });

  describe('team-based', () => {
    test('allows matching team', () => {
      const player = makePlayer({ team: 'red' });
      expect(isAuthorizedForChannel({ team: 'red' }, 'alice', player, null, stubCtx())).toBeTrue();
    });

    test('rejects non-matching team', () => {
      const player = makePlayer({ team: 'blue' });
      expect(isAuthorizedForChannel({ team: 'red' }, 'alice', player, null, stubCtx())).toBeFalse();
    });
  });

  describe('players list', () => {
    test('allows player in explicit list', () => {
      const player = makePlayer();
      expect(
        isAuthorizedForChannel({ players: ['alice', 'bob'] }, 'alice', player, null, stubCtx()),
      ).toBeTrue();
    });

    test('rejects player not in explicit list', () => {
      const player = makePlayer();
      expect(
        isAuthorizedForChannel({ players: ['bob', 'carol'] }, 'alice', player, null, stubCtx()),
      ).toBeFalse();
    });

    test('resolves player list from gameState key', () => {
      const player = makePlayer();
      const ctx = stubCtx({ gameState: { eligible: ['alice', 'carol'] } });
      expect(
        isAuthorizedForChannel({ players: 'eligible' }, 'alice', player, null, ctx),
      ).toBeTrue();
    });

    test('returns false when gameState key is not an array', () => {
      const player = makePlayer();
      const ctx = stubCtx({ gameState: { eligible: 'not-an-array' } });
      expect(
        isAuthorizedForChannel({ players: 'eligible' }, 'alice', player, null, ctx),
      ).toBeFalse();
    });
  });

  describe('function-based', () => {
    test('delegates to function', () => {
      const from = (_ctx: ReadonlyHandlerContext, userId: string) => userId === 'alice';
      const player = makePlayer();
      expect(isAuthorizedForChannel(from, 'alice', player, null, stubCtx())).toBeTrue();
      expect(isAuthorizedForChannel(from, 'bob', player, null, stubCtx())).toBeFalse();
    });
  });

  describe('role + state compound', () => {
    test('requires both role and state to match', () => {
      const player = makePlayer({ role: 'drawer', playerState: 'active' });
      expect(
        isAuthorizedForChannel(
          { role: 'drawer', state: 'active' },
          'alice',
          player,
          null,
          stubCtx(),
        ),
      ).toBeTrue();
    });

    test('rejects when role matches but state does not', () => {
      const player = makePlayer({ role: 'drawer', playerState: 'idle' });
      expect(
        isAuthorizedForChannel(
          { role: 'drawer', state: 'active' },
          'alice',
          player,
          null,
          stubCtx(),
        ),
      ).toBeFalse();
    });
  });

  describe('role + team compound', () => {
    test('requires both role and team to match', () => {
      const player = makePlayer({ role: 'captain', team: 'red' });
      expect(
        isAuthorizedForChannel({ role: 'captain', team: 'red' }, 'alice', player, null, stubCtx()),
      ).toBeTrue();
    });

    test('rejects when team does not match', () => {
      const player = makePlayer({ role: 'captain', team: 'blue' });
      expect(
        isAuthorizedForChannel({ role: 'captain', team: 'red' }, 'alice', player, null, stubCtx()),
      ).toBeFalse();
    });
  });
});

describe('rejectInput', () => {
  test('creates rejection ack with code and reason', () => {
    const ack = rejectInput('INPUT_VALIDATION_FAILED', 'bad data');
    expect(ack.accepted).toBeFalse();
    expect(ack.code).toBe('INPUT_VALIDATION_FAILED');
    expect(ack.reason).toBe('bad data');
  });

  test('includes optional sequence', () => {
    const ack = rejectInput('CHANNEL_NOT_OPEN', 'closed', 5);
    expect(ack.sequence).toBe(5);
  });

  test('includes optional details', () => {
    const ack = rejectInput('INPUT_VALIDATION_FAILED', 'failed', undefined, { field: 'answer' });
    expect(ack.details).toEqual({ field: 'answer' });
  });
});

describe('acceptInput', () => {
  test('creates acceptance ack', () => {
    const ack = acceptInput();
    expect(ack.accepted).toBeTrue();
  });

  test('includes sequence', () => {
    const ack = acceptInput(7);
    expect(ack.sequence).toBe(7);
  });

  test('includes data', () => {
    const ack = acceptInput(1, { processed: true });
    expect(ack.data).toEqual({ processed: true });
  });
});

describe('validateInput', () => {
  test('returns valid with parsed data on success', () => {
    const raw = { schema: z.string() };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, 'hello');
    expect(result.valid).toBeTrue();
    if (result.valid) {
      expect(result.parsed).toBe('hello');
    }
  });

  test('returns valid with coerced data', () => {
    const raw = { schema: z.number() };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, 42);
    expect(result.valid).toBeTrue();
    if (result.valid) {
      expect(result.parsed).toBe(42);
    }
  });

  test('returns rejection ack on validation failure', () => {
    const raw = { schema: z.number() };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, 'not-a-number');
    expect(result.valid).toBeFalse();
    if (!result.valid) {
      expect(result.ack.accepted).toBeFalse();
      expect(result.ack.code).toBe(GameErrorCode.INPUT_VALIDATION_FAILED);
      expect(result.ack.reason).toBe('Input validation failed.');
    }
  });

  test('includes sequence in rejection ack', () => {
    const raw = { schema: z.string().min(5) };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, 'hi', 42);
    expect(result.valid).toBeFalse();
    if (!result.valid) {
      expect(result.ack.sequence).toBe(42);
    }
  });

  test('validates complex schemas', () => {
    const raw = {
      schema: z.object({ x: z.number(), y: z.number() }),
    };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, { x: 1, y: 2 });
    expect(result.valid).toBeTrue();
    if (result.valid) {
      expect(result.parsed).toEqual({ x: 1, y: 2 });
    }
  });

  test('rejects missing required fields', () => {
    const raw = {
      schema: z.object({ x: z.number(), y: z.number() }),
    };
    const def = raw as unknown as ChannelDefinition;
    const result = validateInput(def, { x: 1 });
    expect(result.valid).toBeFalse();
  });
});

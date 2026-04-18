/**
 * Unit tests for the phase state machine.
 *
 * Tests phase state creation, advance trigger resolution, sub-phase traversal,
 * conditional next resolution, and channel completion checks.
 */
import { describe, expect, test } from 'bun:test';
import {
  areAllChannelsComplete,
  createPhaseState,
  getAdvanceTrigger,
  getNextSubPhase,
  getSubPhaseOrder,
  isAnyChannelComplete,
  isConditionalNext,
  isPhaseEnabled,
  resolveDelay,
  resolveTimeout,
} from '../../src/lib/phases';
import type {
  PhaseDefinition,
  ReadonlyHandlerContext,
  SubPhaseDefinition,
} from '../../src/types/models';

/** Minimal ReadonlyHandlerContext stub for tests. */
function stubCtx(overrides: Partial<ReadonlyHandlerContext> = {}): ReadonlyHandlerContext {
  return {
    sessionId: 'test-session',
    gameType: 'test-game',
    rules: {},
    currentPhase: '',
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

describe('createPhaseState', () => {
  test('initializes with null/empty defaults', () => {
    const state = createPhaseState();
    expect(state.currentPhase).toBeNull();
    expect(state.currentSubPhase).toBeNull();
    expect(state.phaseStartedAt).toBeNull();
    expect(state.subPhaseIndex).toBe(0);
    expect(state.resolvedNext).toBeNull();
    expect(state.activeChannels.size).toBe(0);
    expect(state.phaseTimerId).toBeNull();
  });

  test('state is mutable', () => {
    const state = createPhaseState();
    state.currentPhase = 'drawing';
    state.phaseStartedAt = Date.now();
    state.activeChannels.add('draw');
    expect(state.currentPhase).toBe('drawing');
    expect(state.activeChannels.has('draw')).toBeTrue();
  });
});

describe('getAdvanceTrigger', () => {
  test('returns explicit advance trigger', () => {
    const def = { advance: 'allChannelsComplete' } as PhaseDefinition;
    expect(getAdvanceTrigger(def)).toBe('allChannelsComplete');
  });

  test('defaults to timeout when timeout is set', () => {
    const def = { timeout: 30000 } as PhaseDefinition;
    expect(getAdvanceTrigger(def)).toBe('timeout');
  });

  test('defaults to manual when no advance or timeout', () => {
    const def = {} as PhaseDefinition;
    expect(getAdvanceTrigger(def)).toBe('manual');
  });
});

describe('resolveTimeout', () => {
  test('returns null when no timeout', () => {
    const def = {} as PhaseDefinition;
    expect(resolveTimeout(def, stubCtx())).toBeNull();
  });

  test('returns static timeout value', () => {
    const def = { timeout: 5000 } as PhaseDefinition;
    expect(resolveTimeout(def, stubCtx())).toBe(5000);
  });

  test('resolves dynamic timeout function', () => {
    const def = {
      timeout: (ctx: ReadonlyHandlerContext) => ctx.currentRound * 1000,
    } as PhaseDefinition;
    expect(resolveTimeout(def, stubCtx({ currentRound: 3 }))).toBe(3000);
  });
});

describe('resolveDelay', () => {
  test('returns 0 when no delay', () => {
    const def = {} as PhaseDefinition;
    expect(resolveDelay(def, stubCtx())).toBe(0);
  });

  test('returns static delay value', () => {
    const def = { delay: 2000 } as PhaseDefinition;
    expect(resolveDelay(def, stubCtx())).toBe(2000);
  });
});

describe('isPhaseEnabled', () => {
  test('returns true by default', () => {
    const def = {} as PhaseDefinition;
    expect(isPhaseEnabled(def, stubCtx())).toBeTrue();
  });

  test('returns static boolean', () => {
    expect(isPhaseEnabled({ enabled: false } as PhaseDefinition, stubCtx())).toBeFalse();
    expect(isPhaseEnabled({ enabled: true } as PhaseDefinition, stubCtx())).toBeTrue();
  });

  test('evaluates dynamic function', () => {
    const def = {
      enabled: (ctx: ReadonlyHandlerContext) => ctx.currentRound > 1,
    } as PhaseDefinition;
    expect(isPhaseEnabled(def, stubCtx({ currentRound: 1 }))).toBeFalse();
    expect(isPhaseEnabled(def, stubCtx({ currentRound: 2 }))).toBeTrue();
  });
});

describe('isConditionalNext', () => {
  test('detects pipe-separated conditional', () => {
    const def = { next: 'phaseA|phaseB' } as PhaseDefinition;
    expect(isConditionalNext(def)).toBeTrue();
  });

  test('returns false for simple string', () => {
    const def = { next: 'phaseA' } as PhaseDefinition;
    expect(isConditionalNext(def)).toBeFalse();
  });
});

describe('getSubPhaseOrder', () => {
  test('returns empty array when no sub-phases', () => {
    const def = {} as PhaseDefinition;
    expect(getSubPhaseOrder(def)).toEqual([]);
  });

  test('returns sub-phase order when defined', () => {
    const def = {
      subPhases: { a: {}, b: {} },
      subPhaseOrder: ['b', 'a'],
    } as unknown as PhaseDefinition;
    expect(getSubPhaseOrder(def)).toEqual(['b', 'a']);
  });
});

describe('getNextSubPhase', () => {
  test('returns next enabled sub-phase', () => {
    const def = {
      subPhases: {
        first: {} as SubPhaseDefinition,
        second: {} as SubPhaseDefinition,
      },
      subPhaseOrder: ['first', 'second'],
    } as unknown as PhaseDefinition;

    const result = getNextSubPhase(def, -1, stubCtx());
    expect(result).toEqual({ name: 'first', index: 0 });
  });

  test('returns null when at end of order', () => {
    const def = {
      subPhases: {
        first: {} as SubPhaseDefinition,
      },
      subPhaseOrder: ['first'],
    } as unknown as PhaseDefinition;

    const result = getNextSubPhase(def, 0, stubCtx());
    expect(result).toBeNull();
  });

  test('skips disabled sub-phases', () => {
    const def = {
      subPhases: {
        first: {} as SubPhaseDefinition,
        second: { enabled: false } as SubPhaseDefinition,
        third: {} as SubPhaseDefinition,
      },
      subPhaseOrder: ['first', 'second', 'third'],
    } as unknown as PhaseDefinition;

    const result = getNextSubPhase(def, 0, stubCtx());
    expect(result).toEqual({ name: 'third', index: 2 });
  });
});

describe('areAllChannelsComplete', () => {
  test('returns true when all channels complete', () => {
    const active = new Set(['draw', 'guess']);
    const states = new Map([
      ['draw', { complete: true }],
      ['guess', { complete: true }],
    ]);
    expect(areAllChannelsComplete(active, states)).toBeTrue();
  });

  test('returns false when any channel incomplete', () => {
    const active = new Set(['draw', 'guess']);
    const states = new Map([
      ['draw', { complete: true }],
      ['guess', { complete: false }],
    ]);
    expect(areAllChannelsComplete(active, states)).toBeFalse();
  });

  test('returns true for empty channel set', () => {
    expect(areAllChannelsComplete(new Set(), new Map())).toBeTrue();
  });
});

describe('isAnyChannelComplete', () => {
  test('returns true when at least one channel is complete', () => {
    const active = new Set(['draw', 'guess']);
    const states = new Map([
      ['draw', { complete: false }],
      ['guess', { complete: true }],
    ]);
    expect(isAnyChannelComplete(active, states)).toBeTrue();
  });

  test('returns false when no channels are complete', () => {
    const active = new Set(['draw']);
    const states = new Map([['draw', { complete: false }]]);
    expect(isAnyChannelComplete(active, states)).toBeFalse();
  });
});

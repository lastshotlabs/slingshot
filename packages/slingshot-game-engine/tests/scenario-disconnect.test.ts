/**
 * Scenario 3: Disconnect / reconnect
 *
 * Validates: disconnect detection, grace periods, channel disconnect
 * behavior, host transfer, AFK detection, reconnection snapshots,
 * player replacement.
 *
 * Key runtime modules exercised:
 *   - disconnect.ts: all disconnect/reconnect functions
 *   - display.ts: reconnection room management
 *   - replay.ts: disconnect/reconnect replay instrumentation
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DISCONNECT_CONFIG,
  type ResolvedDisconnectConfig,
  areAllPlayersDisconnected,
  buildReconnectionSnapshot,
  checkInactivityAfk,
  clearDisconnect,
  createAfkState,
  createDisconnectState,
  getChannelDisconnectBehavior,
  getGraceTimerId,
  isOverDisconnectLimit,
  isPlayerAfk,
  prepareReplacement,
  recordDisconnect,
  recordPlayerActivity,
  recordTurnTimeout,
  resolveDisconnectConfig,
  resolveGraceExpiry,
  resolveTurnBehavior,
  selectNewHost,
  setGraceTimer,
  shouldPauseOnDisconnect,
} from '../src/lib/disconnect';
import { getPlayerRooms, hostRoom, playerRoom, sessionRoom } from '../src/lib/display';
import {
  createReplaySequence,
  logPlayerDisconnected,
  logPlayerReconnected,
  logPlayerReplaced,
} from '../src/lib/replay';
import type { GamePlayerState } from '../src/types/models';

function makePlayer(userId: string, overrides?: Partial<GamePlayerState>): GamePlayerState {
  return {
    userId,
    displayName: userId,
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: false,
    isSpectator: false,
    joinOrder: 1,
    ...overrides,
  };
}

describe('Disconnect / reconnect scenario', () => {
  describe('disconnect config resolution', () => {
    test('returns defaults when no overrides', () => {
      const config = resolveDisconnectConfig({}, null);
      expect(config).toEqual(DEFAULT_DISCONNECT_CONFIG);
    });

    test('plugin-level overrides merge with defaults', () => {
      const config = resolveDisconnectConfig({ gracePeriodMs: 30_000, maxDisconnects: 3 }, null);
      expect(config.gracePeriodMs).toBe(30_000);
      expect(config.maxDisconnects).toBe(3);
      expect(config.pauseOnDisconnect).toBe('never'); // default
    });

    test('game-level overrides take precedence', () => {
      const config = resolveDisconnectConfig(
        { gracePeriodMs: 30_000 },
        {
          gracePeriodMs: 10_000,
          pauseOnDisconnect: 'always',
        },
      );
      expect(config.gracePeriodMs).toBe(10_000);
      expect(config.pauseOnDisconnect).toBe('always');
    });

    test('dynamic grace period via function', () => {
      const config = resolveDisconnectConfig(
        {},
        {
          gracePeriodMs: () => 5_000,
        },
        {} as any,
      );
      expect(config.gracePeriodMs).toBe(5_000);
    });
  });

  describe('disconnect recording and snapshots', () => {
    test('records disconnect and creates snapshot', () => {
      const state = createDisconnectState();
      const player = makePlayer('p1', { playerState: 'alive' });

      const snapshot = recordDisconnect(state, player, 'p1', 15_000);

      expect(snapshot.userId).toBe('p1');
      expect(snapshot.wasActivePlayer).toBe(true);
      expect(snapshot.turnTimeRemaining).toBe(15_000);
      expect(snapshot.playerState).toBe('alive');
      expect(state.snapshots.has('p1')).toBe(true);
    });

    test('records snapshot for non-active player', () => {
      const state = createDisconnectState();
      const player = makePlayer('p2');

      const snapshot = recordDisconnect(state, player, 'p1', null);

      expect(snapshot.wasActivePlayer).toBe(false);
      expect(snapshot.turnTimeRemaining).toBeNull();
    });
  });

  describe('grace timer management', () => {
    test('set and get grace timer', () => {
      const state = createDisconnectState();

      setGraceTimer(state, 'p1', 'timer-123');
      expect(getGraceTimerId(state, 'p1')).toBe('timer-123');
      expect(getGraceTimerId(state, 'p2')).toBeNull();
    });

    test('clear disconnect removes snapshot and timer', () => {
      const state = createDisconnectState();
      const player = makePlayer('p1');

      recordDisconnect(state, player, null, null);
      setGraceTimer(state, 'p1', 'timer-abc');

      const snapshot = clearDisconnect(state, 'p1');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.userId).toBe('p1');
      expect(state.snapshots.has('p1')).toBe(false);
      expect(state.graceTimers.has('p1')).toBe(false);
    });

    test('clear returns null if no snapshot exists', () => {
      const state = createDisconnectState();
      expect(clearDisconnect(state, 'unknown')).toBeNull();
    });
  });

  describe('disconnect limits', () => {
    test('not over limit when count is below max', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        maxDisconnects: 3,
      };
      expect(isOverDisconnectLimit(2, config)).toBe(false);
    });

    test('over limit when count equals max', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        maxDisconnects: 3,
      };
      expect(isOverDisconnectLimit(3, config)).toBe(true);
    });

    test('never over limit when max is 0 (disabled)', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        maxDisconnects: 0,
      };
      expect(isOverDisconnectLimit(100, config)).toBe(false);
    });
  });

  describe('pause on disconnect', () => {
    test('never pause when config is "never"', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        pauseOnDisconnect: 'never',
      };
      expect(shouldPauseOnDisconnect(config, true)).toBe(false);
      expect(shouldPauseOnDisconnect(config, false)).toBe(false);
    });

    test('always pause when config is "always"', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        pauseOnDisconnect: 'always',
      };
      expect(shouldPauseOnDisconnect(config, true)).toBe(true);
      expect(shouldPauseOnDisconnect(config, false)).toBe(true);
    });

    test('pause only for turn player when "turn-player"', () => {
      const config: ResolvedDisconnectConfig = {
        ...DEFAULT_DISCONNECT_CONFIG,
        pauseOnDisconnect: 'turn-player',
      };
      expect(shouldPauseOnDisconnect(config, true)).toBe(true);
      expect(shouldPauseOnDisconnect(config, false)).toBe(false);
    });
  });

  describe('turn behavior on disconnect', () => {
    test('resolves configured turn behavior', () => {
      expect(resolveTurnBehavior({ ...DEFAULT_DISCONNECT_CONFIG, turnBehavior: 'skip' })).toBe(
        'skip',
      );
      expect(resolveTurnBehavior({ ...DEFAULT_DISCONNECT_CONFIG, turnBehavior: 'timeout' })).toBe(
        'timeout',
      );
      expect(
        resolveTurnBehavior({ ...DEFAULT_DISCONNECT_CONFIG, turnBehavior: 'auto-action' }),
      ).toBe('auto-action');
      expect(resolveTurnBehavior({ ...DEFAULT_DISCONNECT_CONFIG, turnBehavior: 'pause' })).toBe(
        'pause',
      );
    });
  });

  describe('host transfer', () => {
    test('selects longest-connected player as new host', () => {
      const players = [
        makePlayer('host', { isHost: true, joinOrder: 1 }),
        makePlayer('p2', { joinOrder: 3 }),
        makePlayer('p3', { joinOrder: 2 }),
      ];

      const newHost = selectNewHost(players, 'host');
      expect(newHost).toBe('p3'); // joinOrder 2 is oldest after host
    });

    test('skips disconnected and spectator players', () => {
      const players = [
        makePlayer('host', { isHost: true, joinOrder: 1 }),
        makePlayer('p2', { joinOrder: 2, connected: false }),
        makePlayer('p3', { joinOrder: 3, isSpectator: true }),
        makePlayer('p4', { joinOrder: 4 }),
      ];

      const newHost = selectNewHost(players, 'host');
      expect(newHost).toBe('p4');
    });

    test('returns null if no candidates remain', () => {
      const players = [
        makePlayer('host', { isHost: true, joinOrder: 1 }),
        makePlayer('p2', { joinOrder: 2, connected: false }),
      ];

      expect(selectNewHost(players, 'host')).toBeNull();
    });
  });

  describe('all players disconnected', () => {
    test('detects when all non-spectators are disconnected', () => {
      const players = [
        makePlayer('p1', { connected: false }),
        makePlayer('p2', { connected: false }),
        makePlayer('spec', { connected: true, isSpectator: true }),
      ];

      expect(areAllPlayersDisconnected(players)).toBe(true);
    });

    test('false when at least one player connected', () => {
      const players = [
        makePlayer('p1', { connected: false }),
        makePlayer('p2', { connected: true }),
      ];

      expect(areAllPlayersDisconnected(players)).toBe(false);
    });
  });

  describe('channel disconnect behavior', () => {
    test('collect channels: player abstains', () => {
      const action = getChannelDisconnectBehavior('collect', false);
      expect(action.action).toBe('abstain');
    });

    test('race channels: stop sending', () => {
      const action = getChannelDisconnectBehavior('race', false);
      expect(action.action).toBe('stop-sending');
    });

    test('stream channels: stop sending', () => {
      const action = getChannelDisconnectBehavior('stream', true);
      expect(action.action).toBe('stop-sending');
    });

    test('turn channels: apply turn behavior if active player', () => {
      const active = getChannelDisconnectBehavior('turn', true);
      expect(active.action).toBe('apply-turn-behavior');

      const inactive = getChannelDisconnectBehavior('turn', false);
      expect(inactive.action).toBe('no-effect');
    });

    test('vote channels: player abstains', () => {
      const action = getChannelDisconnectBehavior('vote', false);
      expect(action.action).toBe('abstain');
    });

    test('free channels: stop sending', () => {
      const action = getChannelDisconnectBehavior('free', false);
      expect(action.action).toBe('stop-sending');
    });

    test('unknown mode: no effect', () => {
      const action = getChannelDisconnectBehavior('unknown', false);
      expect(action.action).toBe('no-effect');
    });
  });

  describe('player replacement', () => {
    test('transfers game data from old to new player', () => {
      const oldPlayer = makePlayer('old-user', {
        score: 150,
        role: 'mafia',
        team: 'red',
        playerState: 'alive',
      });

      const result = prepareReplacement(oldPlayer, 'new-user', 'NewPlayer');

      expect(result.oldUserId).toBe('old-user');
      expect(result.newUserId).toBe('new-user');
      expect(result.newDisplayName).toBe('NewPlayer');
      expect(result.transferred.score).toBe(150);
      expect(result.transferred.role).toBe('mafia');
      expect(result.transferred.team).toBe('red');
      expect(result.transferred.playerState).toBe('alive');
    });
  });

  describe('AFK detection', () => {
    test('records activity and clears AFK', () => {
      const afk = createAfkState();

      recordPlayerActivity(afk, 'p1');
      expect(isPlayerAfk(afk, 'p1')).toBe(false);
    });

    test('flags AFK after consecutive turn timeouts', () => {
      const afk = createAfkState();

      expect(recordTurnTimeout(afk, 'p1', 3)).toBe(false);
      expect(recordTurnTimeout(afk, 'p1', 3)).toBe(false);
      expect(recordTurnTimeout(afk, 'p1', 3)).toBe(true);

      expect(isPlayerAfk(afk, 'p1')).toBe(true);
    });

    test('activity resets consecutive timeouts', () => {
      const afk = createAfkState();

      recordTurnTimeout(afk, 'p1', 3);
      recordTurnTimeout(afk, 'p1', 3);
      recordPlayerActivity(afk, 'p1'); // Resets

      expect(recordTurnTimeout(afk, 'p1', 3)).toBe(false); // Counter reset
    });

    test('inactivity check flags AFK after threshold', () => {
      const afk = createAfkState();

      // Simulate old activity
      afk.lastInputAt.set('p1', Date.now() - 120_000);

      const result = checkInactivityAfk(afk, 'p1', 60_000);
      expect(result).toBe(true);
      expect(isPlayerAfk(afk, 'p1')).toBe(true);
    });

    test('inactivity check returns false for recent activity', () => {
      const afk = createAfkState();
      afk.lastInputAt.set('p1', Date.now() - 10_000);

      expect(checkInactivityAfk(afk, 'p1', 60_000)).toBe(false);
    });

    test('inactivity check returns false for unknown player', () => {
      const afk = createAfkState();
      expect(checkInactivityAfk(afk, 'unknown', 60_000)).toBe(false);
    });
  });

  describe('grace period expiry', () => {
    test('resolves expiry actions — active player with skip behavior', () => {
      const config: ResolvedDisconnectConfig = {
        gracePeriodMs: 60_000,
        maxDisconnects: 5,
        pauseOnDisconnect: 'turn-player',
        turnBehavior: 'skip',
        autoActionHandler: null,
      };

      const snapshot = {
        userId: 'p1',
        disconnectedAt: Date.now() - 60_000,
        wasActivePlayer: true,
        turnTimeRemaining: 5_000,
        playerState: 'alive',
      };

      const players = [
        makePlayer('p1', { connected: false }),
        makePlayer('p2', { connected: true }),
      ];

      const actions = resolveGraceExpiry(config, snapshot, players);

      expect(actions.unpause).toBe(true); // turn-player + was active
      expect(actions.skipTurn).toBe(true); // skip behavior
      expect(actions.allDisconnected).toBe(false);
    });

    test('all disconnected triggers abandonment', () => {
      const config = DEFAULT_DISCONNECT_CONFIG;

      const snapshot = {
        userId: 'p1',
        disconnectedAt: Date.now(),
        wasActivePlayer: false,
        turnTimeRemaining: null,
        playerState: null,
      };

      const players = [
        makePlayer('p1', { connected: false }),
        makePlayer('p2', { connected: false }),
      ];

      const actions = resolveGraceExpiry(config, snapshot, players);
      expect(actions.allDisconnected).toBe(true);
    });
  });

  describe('reconnection snapshot', () => {
    test('builds full snapshot for reconnecting player', () => {
      const players = [
        makePlayer('p1', { score: 100, role: 'drawer', connected: true, isHost: true }),
        makePlayer('p2', { score: 50, connected: true }),
      ];

      const channels = new Map([
        ['guess', { name: 'guess', mode: 'collect', open: true, endsAt: null }],
      ]);

      const scores = new Map([
        ['p1', 100],
        ['p2', 50],
      ]);

      const snapshot = buildReconnectionSnapshot(
        'sess-1',
        {
          status: 'playing',
          currentPhase: 'drawing',
          currentSubPhase: null,
          rules: { rounds: 5 },
        },
        players,
        { round: 3, word: 'hidden' },
        { hand: ['card1'] },
        'p1',
        channels,
        scores,
        Date.now() + 30_000,
      );

      expect(snapshot.type).toBe('game:state.snapshot');
      expect(snapshot.sessionId).toBe('sess-1');
      expect(snapshot.currentPhase).toBe('drawing');
      expect(snapshot.activePlayer).toBe('p1');
      expect((snapshot.gameState as Record<string, unknown>).round).toBe(3);
      expect(snapshot.privateState).toEqual({ hand: ['card1'] });
      expect((snapshot.scores as Record<string, number>).p1).toBe(100);
    });
  });

  describe('room management', () => {
    test('player gets correct room subscriptions', () => {
      const player = makePlayer('p1', {
        isHost: true,
        team: 'blue',
        role: 'captain',
      });

      const rooms = getPlayerRooms('sess-1', player);

      expect(rooms).toContain(sessionRoom('sess-1'));
      expect(rooms).toContain(playerRoom('sess-1', 'p1'));
      expect(rooms).toContain(hostRoom('sess-1'));
      expect(rooms).toContain('sessions:sess-1:team:blue');
      expect(rooms).toContain('sessions:sess-1:role:captain');
    });

    test('spectator only gets session and spectator rooms', () => {
      const spectator = makePlayer('spec', { isSpectator: true });
      const rooms = getPlayerRooms('sess-1', spectator);

      expect(rooms).toContain(sessionRoom('sess-1'));
      expect(rooms).toContain('sessions:sess-1:spectators');
      expect(rooms).not.toContain(playerRoom('sess-1', 'spec'));
    });
  });

  describe('replay log instrumentation', () => {
    test('disconnect and reconnect replay entries', () => {
      const seq = createReplaySequence();

      const disconnectEntry = logPlayerDisconnected('sess-1', seq, {
        userId: 'p1',
        wasActivePlayer: true,
        gracePeriodMs: 60_000,
      });

      expect(disconnectEntry.type).toBe('player.disconnected');
      expect(disconnectEntry.sequence).toBe(1);
      expect((disconnectEntry.data as Record<string, unknown>).userId).toBe('p1');

      const reconnectEntry = logPlayerReconnected('sess-1', seq, {
        userId: 'p1',
        disconnectedForMs: 15_000,
      });

      expect(reconnectEntry.type).toBe('player.reconnected');
      expect(reconnectEntry.sequence).toBe(2);
    });

    test('player replacement replay entry', () => {
      const seq = createReplaySequence();

      const entry = logPlayerReplaced('sess-1', seq, {
        oldUserId: 'old',
        newUserId: 'new',
        newDisplayName: 'NewPlayer',
      });

      expect(entry.type).toBe('player.replaced');
      expect((entry.data as Record<string, unknown>).oldUserId).toBe('old');
    });
  });
});

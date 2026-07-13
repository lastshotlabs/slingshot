import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import { createSessionControls } from '../../src/lib/sessionControl';
import {
  type SessionRuntime,
  createSessionRuntime,
  destroySessionRuntime,
} from '../../src/lib/sessionRuntime';
import type { GamePlayerState } from '../../src/types/models';

const activeRuntimeMaps: Array<Map<string, SessionRuntime>> = [];

afterEach(() => {
  for (const activeRuntimes of activeRuntimeMaps.splice(0)) {
    for (const sessionId of [...activeRuntimes.keys()]) {
      destroySessionRuntime(activeRuntimes, sessionId);
    }
  }
});

const controlGame = defineGame({
  name: 'control-test',
  display: 'Control Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: {
    mode: 'cumulative',
    display: { label: 'Score' },
  },
  sync: {
    mode: 'event',
  },
  phases: {
    lobby: {
      next: 'play',
      advance: 'manual',
    },
    play: {
      next: 'results',
      advance: 'any-channel-complete',
      channels: {
        answer: {
          mode: 'collect',
          from: 'all-players',
          relay: 'none',
          schema: z.object({
            answer: z.string().min(1),
          }),
          allowChange: true,
        },
      },
    },
    bonus: {
      next: 'results',
      advance: 'manual',
    },
    results: {
      next: null,
      advance: 'manual',
    },
  },
  handlers: {},
});

function makePlayer(overrides: Partial<GamePlayerState> = {}): GamePlayerState {
  return {
    userId: 'host-user',
    displayName: 'Host',
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: true,
    isSpectator: false,
    joinOrder: 1,
    ...overrides,
  };
}

async function createHarness() {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);

  const runtime = await createSessionRuntime(
    'session-1',
    controlGame,
    {},
    [
      makePlayer(),
      makePlayer({ userId: 'player-2', displayName: 'Player Two', isHost: false, joinOrder: 2 }),
    ],
    1234,
    {
      publish() {},
      replayStore: createInMemoryReplayStore(),
      log: {
        debug() {},
        info() {},
        warn() {},
        error(message: string): void {
          throw new Error(message);
        },
      },
      activeRuntimes,
    },
  );

  if (!runtime) {
    throw new Error('Expected createSessionRuntime() to create a runtime.');
  }

  return {
    activeRuntimes,
    controls: createSessionControls(activeRuntimes),
    runtime,
  };
}

describe('createSessionControls', () => {
  test('returns read-only active-session snapshots and presence checks', async () => {
    const { controls, runtime } = await createHarness();
    runtime.gameState.board = { clueId: 'clue-1' };

    const snapshot = controls.get('session-1');
    expect(snapshot?.sessionId).toBe('session-1');
    expect(snapshot?.gameType).toBe('control-test');
    expect(snapshot?.currentPhase).toBe('lobby');
    expect(snapshot?.players.map(player => player.userId)).toEqual(['host-user', 'player-2']);
    expect(snapshot?.leaderboard.players).toEqual([
      { userId: 'host-user', score: 0, rank: 1 },
      { userId: 'player-2', score: 0, rank: 1 },
    ]);
    expect(controls.has('session-1')).toBeTrue();
    expect(controls.has('missing')).toBeFalse();
    expect(controls.list().map(entry => entry.sessionId)).toEqual(['session-1']);

    runtime.gameState.board = { clueId: 'clue-2' };
    expect(snapshot?.gameState).toEqual({ board: { clueId: 'clue-1' } });
  });

  test('advances active sessions and supports explicit next-phase overrides', async () => {
    const { controls, runtime } = await createHarness();

    const next = await controls.advancePhase('session-1');
    expect(next?.currentPhase).toBe('play');
    expect(runtime.phaseState.currentPhase).toBe('play');

    const overridden = await controls.advancePhase('session-1', { nextPhase: 'bonus' });
    expect(overridden?.currentPhase).toBe('bonus');
    expect(runtime.phaseState.currentPhase).toBe('bonus');
  });

  test('returns null for inactive sessions and rejects invalid active-session transitions', async () => {
    const { controls, runtime } = await createHarness();

    expect(await controls.advancePhase('missing')).toBeNull();

    try {
      await controls.advancePhase('session-1', { nextPhase: 'missing-phase' });
      throw new Error('Expected advancePhase() to reject for an unknown phase.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Unknown phase "missing-phase".');
    }

    runtime.phaseState.currentPhase = null;
    try {
      await controls.advancePhase('session-1');
      throw new Error('Expected advancePhase() to reject when currentPhase is missing.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Active runtime is missing a current phase.');
    }
  });

  test('submits input through the public control surface', async () => {
    const { controls, runtime } = await createHarness();

    await controls.advancePhase('session-1');
    const ack = await controls.submitInput('session-1', {
      channel: 'answer',
      userId: 'player-2',
      data: { answer: 'test' },
      sequence: 9,
    });

    expect(ack).toEqual({
      accepted: true,
      sequence: 9,
    });
    expect(runtime.channels.get('answer')?.submissions.get('player-2')?.input).toEqual({
      answer: 'test',
    });
    expect(
      await controls.submitInput('missing', {
        channel: 'answer',
        userId: 'player-2',
        data: { answer: 'test' },
        sequence: 10,
      }),
    ).toBeNull();
  });

  test('runs controlled mutations without exposing the raw runtime', async () => {
    const { controls } = await createHarness();

    const result = await controls.mutate('session-1', ({ ctx, publishToSession }) => {
      ctx.gameState.board = { clueId: 'clue-7' };
      ctx.setPlayerState('player-2', 'answering');
      ctx.addScore('player-2', 200, { reason: 'control-test' });
      publishToSession({
        type: 'custom:event',
        sessionId: ctx.sessionId,
      });
      return 'ok';
    });

    expect(result?.value).toBe('ok');
    expect(result?.snapshot.gameState).toEqual({ board: { clueId: 'clue-7' } });
    expect(result?.snapshot.players.find(player => player.userId === 'player-2')?.playerState).toBe(
      'answering',
    );
    expect(result?.snapshot.players.find(player => player.userId === 'player-2')?.score).toBe(200);
    expect(result?.snapshot.leaderboard.players).toEqual([
      { userId: 'player-2', score: 200, rank: 1 },
      { userId: 'host-user', score: 0, rank: 2 },
    ]);

    expect(await controls.mutate('missing', () => 'never')).toBeNull();
  });

  test('keeps currentRound live across repeated mutation-surface updates', async () => {
    const { controls } = await createHarness();

    const result = await controls.mutate('session-1', ({ ctx }) => {
      ctx.incrementRound();
      ctx.incrementRound();
      return { currentRound: ctx.currentRound };
    });

    expect(result?.value).toEqual({ currentRound: 3 });
    expect(result?.snapshot.currentRound).toBe(3);
  });
});

describe('transferHost', () => {
  /** Fake persistence: rows mirror the two players the harness creates. */
  function makeAdapters(initial?: Array<Record<string, unknown>>) {
    const rows: Array<Record<string, unknown>> = initial ?? [
      {
        id: 'row-1',
        sessionId: 'session-1',
        userId: 'host-user',
        isHost: true,
        isSpectator: false,
      },
      {
        id: 'row-2',
        sessionId: 'session-1',
        userId: 'player-2',
        isHost: false,
        isSpectator: false,
      },
    ];
    const session: Record<string, unknown> = { id: 'session-1', hostUserId: 'host-user' };
    return {
      rows,
      session,
      adapters: {
        sessionAdapter: {
          update(_id: string, patch: Record<string, unknown>) {
            Object.assign(session, patch);
          },
        },
        playerAdapter: {
          async find() {
            return rows;
          },
          update(id: string, patch: Record<string, unknown>) {
            const row = rows.find(candidate => candidate.id === id);
            if (row) Object.assign(row, patch);
          },
        },
      },
    };
  }

  test('moves the host role across rows, session, and runtime, and broadcasts', async () => {
    const { activeRuntimes, runtime } = await createHarness();
    const published: Array<Record<string, unknown>> = [];
    runtime.publish = (_room: string, message: unknown) => {
      published.push(message as Record<string, unknown>);
    };
    const { rows, session, adapters } = makeAdapters();
    const controls = createSessionControls(activeRuntimes, adapters as never);

    const snapshot = await controls.transferHost('session-1', 'player-2');

    // Persisted rows: exactly one host, and it is the new one.
    expect(rows.filter(row => row.isHost === true).map(row => row.userId)).toEqual(['player-2']);
    expect(session.hostUserId).toBe('player-2');

    // Runtime mirrors it.
    expect(snapshot?.players.find(p => p.userId === 'player-2')?.isHost).toBe(true);
    expect(snapshot?.players.find(p => p.userId === 'host-user')?.isHost).toBe(false);

    const event = published.find(message => message.type === 'game:host.transferred');
    expect(event).toMatchObject({
      type: 'game:host.transferred',
      sessionId: 'session-1',
      newHostUserId: 'player-2',
      previousHostUserId: 'host-user',
    });
  });

  test('repairs a roster that already has a stale second host', async () => {
    // The regression this replaces: the old auto-transfer left `isHost` set on
    // a contestant with no restore path, so two rows claimed the host role.
    const { activeRuntimes } = await createHarness();
    const { rows, adapters } = makeAdapters([
      {
        id: 'row-1',
        sessionId: 'session-1',
        userId: 'host-user',
        isHost: true,
        isSpectator: false,
      },
      { id: 'row-2', sessionId: 'session-1', userId: 'player-2', isHost: true, isSpectator: false },
    ]);
    const controls = createSessionControls(activeRuntimes, adapters as never);

    await controls.transferHost('session-1', 'player-2');

    expect(rows.filter(row => row.isHost === true).map(row => row.userId)).toEqual(['player-2']);
  });

  test('rejects a non-member and a spectator', async () => {
    const { activeRuntimes } = await createHarness();
    const { adapters } = makeAdapters([
      {
        id: 'row-1',
        sessionId: 'session-1',
        userId: 'host-user',
        isHost: true,
        isSpectator: false,
      },
      { id: 'row-3', sessionId: 'session-1', userId: 'watcher', isHost: false, isSpectator: true },
    ]);
    const controls = createSessionControls(activeRuntimes, adapters as never);

    await expect(controls.transferHost('session-1', 'nobody')).rejects.toThrow(/not in session/);
    await expect(controls.transferHost('session-1', 'watcher')).rejects.toThrow(/spectator/);
  });

  test('persists without a live runtime (lobby has no runtime)', async () => {
    const activeRuntimes = new Map<string, SessionRuntime>();
    const { rows, session, adapters } = makeAdapters();
    const controls = createSessionControls(activeRuntimes, adapters as never);

    const snapshot = await controls.transferHost('session-1', 'player-2');

    expect(snapshot).toBeNull();
    expect(session.hostUserId).toBe('player-2');
    expect(rows.filter(row => row.isHost === true).map(row => row.userId)).toEqual(['player-2']);
  });
});

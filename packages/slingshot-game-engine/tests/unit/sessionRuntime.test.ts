import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import {
  type SessionRuntime,
  createSessionRuntime,
  destroySessionRuntime,
  handleDisconnect,
  handleReconnectFlow,
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

const runtimeGame = defineGame({
  name: 'runtime-test',
  display: 'Runtime Test',
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
    runtimeGame,
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

  return runtime;
}

describe('session runtime reconnect flow', () => {
  test('cancels the stored grace timer before clearing disconnect state', async () => {
    const runtime = await createHarness();

    await handleDisconnect(runtime, 'player-2');

    const graceTimerId = runtime.disconnectState.graceTimers.get('player-2');
    expect(graceTimerId).toBeString();
    expect(runtime.timerState.timers.has(graceTimerId!)).toBeTrue();

    const subscribedRooms: string[] = [];
    const acknowledgements: unknown[] = [];
    const publishedMessages: Array<{ room: string; data: unknown }> = [];

    await handleReconnectFlow(
      runtime,
      'player-2',
      room => {
        subscribedRooms.push(room);
      },
      data => {
        acknowledgements.push(data);
      },
      (room, data) => {
        publishedMessages.push({ room, data });
      },
    );

    expect(runtime.disconnectState.graceTimers.has('player-2')).toBeFalse();
    expect(runtime.timerState.timers.has(graceTimerId!)).toBeFalse();
    expect(runtime.players.get('player-2')?.connected).toBeTrue();
    expect(subscribedRooms.length).toBeGreaterThan(0);
    expect(acknowledgements).toHaveLength(1);
    expect(publishedMessages).toHaveLength(1);
  });
});

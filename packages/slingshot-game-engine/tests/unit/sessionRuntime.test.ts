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
  handleSubscribeConnection,
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

describe('socket-scoped presence', () => {
  // The live failure this guards: a phone locks, its socket goes stale WITHOUT
  // delivering a close, the phone wakes and opens a fresh socket that
  // subscribes — and only then does the stale socket's close land. Marking the
  // player disconnected there stranded them for the rest of the game, because
  // a subscribed client never subscribes again.
  test('a stale socket closing behind a live one does not drop presence', async () => {
    const runtime = await createHarness();

    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-a');
    // The wake: a second socket for the same player, opened before the first
    // one's close was ever seen.
    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-b');

    await handleDisconnect(runtime, 'player-2', 'socket-a');

    expect(runtime.players.get('player-2')?.connected).toBeTrue();
    expect(runtime.players.get('player-2')?.disconnectedAt).toBeNull();
    expect(runtime.disconnectState.graceTimers.has('player-2')).toBeFalse();
  });

  test('the last socket closing still disconnects the player', async () => {
    const runtime = await createHarness();

    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-a');
    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-b');

    await handleDisconnect(runtime, 'player-2', 'socket-a');
    await handleDisconnect(runtime, 'player-2', 'socket-b');

    expect(runtime.players.get('player-2')?.connected).toBeFalse();
    expect(runtime.disconnectState.graceTimers.has('player-2')).toBeTrue();
  });

  test('a reconnect registers its socket, so the pre-reconnect close is ignored', async () => {
    const runtime = await createHarness();

    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-a');
    await handleReconnectFlow(
      runtime,
      'player-2',
      () => {},
      () => {},
      () => {},
      'socket-b',
    );

    await handleDisconnect(runtime, 'player-2', 'socket-a');

    expect(runtime.players.get('player-2')?.connected).toBeTrue();
  });

  test('a caller with no socket id keeps the unconditional legacy behavior', async () => {
    const runtime = await createHarness();

    await handleDisconnect(runtime, 'player-2');

    expect(runtime.players.get('player-2')?.connected).toBeFalse();
  });

  test('an unregistered socket closing cannot evict a live one', async () => {
    const runtime = await createHarness();

    await handleSubscribeConnection(runtime, 'player-2', () => {}, 'socket-live');
    // A socket that never subscribed (it upgraded, then closed) must not be
    // able to take presence down with it.
    await handleDisconnect(runtime, 'player-2', 'socket-never-subscribed');

    expect(runtime.players.get('player-2')?.connected).toBeTrue();
  });
});

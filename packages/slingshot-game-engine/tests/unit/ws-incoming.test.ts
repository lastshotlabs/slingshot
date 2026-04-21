import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { GameErrorCode } from '../../src/errors';
import { buildIncomingDispatch } from '../../src/ws/incoming';

const gameDef = defineGame({
  name: 'ws-test',
  display: 'WS Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  phases: {
    lobby: { next: 'play', advance: 'manual' },
    play: { next: null, advance: 'manual' },
  },
  handlers: {},
});

function findHandler(event: string) {
  const handlers = buildIncomingDispatch({
    async resolveSession(sessionId: string) {
      if (sessionId === 'missing') return null;
      return {
        session: {
          id: sessionId,
          gameType: 'ws-test',
          status: sessionId === 'done' ? 'completed' : 'lobby',
          hostUserId: 'host-user',
        },
        players: [
          {
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
          },
          {
            userId: 'guest-user',
            displayName: 'Guest',
            role: null,
            team: null,
            playerState: null,
            score: 0,
            connected: true,
            isHost: false,
            isSpectator: false,
            joinOrder: 2,
          },
        ],
        gameDef,
      };
    },
    async processInput(sessionId, channel, userId, data, sequence) {
      return {
        accepted: true,
        data: { sessionId, channel, userId, echoed: data, sequence },
      };
    },
    async handleReconnect(sessionId, userId, subscribe, ack, publish) {
      subscribe(`session:${sessionId}`);
      ack({ type: 'game:reconnect.ack', sessionId, userId });
      publish(`session:${sessionId}`, { type: 'game:player.reconnected', userId });
    },
    bus: {
      emit() {},
    },
  });

  const handler = handlers.find(entry => entry.event === event);
  if (!handler) {
    throw new Error(`Missing handler for ${event}`);
  }
  return handler.handler;
}

function makeWsContext(userId = 'host-user') {
  const acknowledgements: unknown[] = [];
  const publications: Array<{ room: string; data: unknown }> = [];
  const subscriptions: string[] = [];
  const unsubscriptions: string[] = [];

  return {
    ctx: {
      userId,
      socketId: 'socket-1',
      payload: null,
      ack(data: unknown) {
        acknowledgements.push(data);
      },
      publish(room: string, data: unknown) {
        publications.push({ room, data });
      },
      subscribe(room: string) {
        subscriptions.push(room);
      },
      unsubscribe(room: string) {
        unsubscriptions.push(room);
      },
    },
    acknowledgements,
    publications,
    subscriptions,
    unsubscriptions,
  };
}

describe('ws incoming dispatch', () => {
  test('subscribes players and returns a state snapshot', async () => {
    const { ctx, acknowledgements, subscriptions } = makeWsContext('guest-user');
    ctx.payload = { type: 'game:subscribe', sessionId: 'session-1' };

    await findHandler('game:subscribe')(ctx as any);

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(acknowledgements[0]).toMatchObject({
      type: 'game:state.snapshot',
      sessionId: 'session-1',
    });
  });

  test('rejects reconnects for completed sessions and forwards successful reconnects', async () => {
    const invalid = makeWsContext('guest-user');
    invalid.ctx.payload = { type: 'game:reconnect', sessionId: 'done' };

    await findHandler('game:reconnect')(invalid.ctx as any);
    expect(invalid.acknowledgements[0]).toMatchObject({
      code: GameErrorCode.SESSION_COMPLETED,
    });

    const valid = makeWsContext('guest-user');
    valid.ctx.payload = { type: 'game:reconnect', sessionId: 'session-1' };

    await findHandler('game:reconnect')(valid.ctx as any);

    expect(valid.subscriptions).toContain('session:session-1');
    expect(valid.acknowledgements[0]).toEqual({
      type: 'game:reconnect.ack',
      sessionId: 'session-1',
      userId: 'guest-user',
    });
    expect(valid.publications[0]).toEqual({
      room: 'session:session-1',
      data: { type: 'game:player.reconnected', userId: 'guest-user' },
    });
  });

  test('acks processed input and wires unsubscribe and stream room changes', async () => {
    const input = makeWsContext('guest-user');
    input.ctx.payload = {
      type: 'game:input',
      sessionId: 'session-1',
      channel: 'buzz',
      data: { answer: 'A' },
      sequence: 4,
    };

    await findHandler('game:input')(input.ctx as any);
    expect(input.acknowledgements[0]).toMatchObject({
      type: 'game:input.ack',
      sessionId: 'session-1',
      channel: 'buzz',
      sequence: 4,
      accepted: true,
    });

    const rooms = makeWsContext('guest-user');
    rooms.ctx.payload = { type: 'game:stream.subscribe', sessionId: 'session-1', channel: 'state' };
    await findHandler('game:stream.subscribe')(rooms.ctx as any);
    rooms.ctx.payload = {
      type: 'game:stream.unsubscribe',
      sessionId: 'session-1',
      channel: 'state',
    };
    await findHandler('game:stream.unsubscribe')(rooms.ctx as any);
    rooms.ctx.payload = { type: 'game:unsubscribe', sessionId: 'session-1' };
    await findHandler('game:unsubscribe')(rooms.ctx as any);

    expect(rooms.subscriptions.length).toBe(1);
    expect(rooms.unsubscriptions.length).toBe(3);
  });

  test('returns structured errors for invalid subscribe payloads and missing sessions', async () => {
    const invalid = makeWsContext();
    invalid.ctx.payload = { type: 'game:subscribe' };

    await findHandler('game:subscribe')(invalid.ctx as any);
    expect(invalid.acknowledgements[0]).toMatchObject({
      code: GameErrorCode.INPUT_VALIDATION_FAILED,
    });

    const missing = makeWsContext();
    missing.ctx.payload = { type: 'game:subscribe', sessionId: 'missing' };

    await findHandler('game:subscribe')(missing.ctx as any);
    expect(missing.acknowledgements[0]).toMatchObject({
      code: GameErrorCode.SESSION_NOT_FOUND,
    });
  });
});

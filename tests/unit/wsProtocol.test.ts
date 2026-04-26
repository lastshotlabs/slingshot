/**
 * Integration-level tests for the full WebSocket protocol pipeline.
 * Exercises dispatch, rate limiting, and recovery together using mocks
 * that replicate the server.ts wiring without requiring a live Bun server.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { handleIncomingEvent } from '../../src/framework/ws/dispatch';
import { checkRateLimit } from '../../src/framework/ws/rateLimit';
import { pruneExpiredSessions, writeSession } from '../../src/framework/ws/recovery';
import { handleRoomActions, publish } from '../../src/framework/ws/rooms';

function createWsState(overrides?: Partial<WsState>): WsState {
  return {
    server: null,
    transport: null,
    instanceId: 'test-instance',
    presenceEnabled: false,
    roomRegistry: new Map(),
    heartbeatSockets: new Map(),
    heartbeatEndpointConfigs: new Map(),
    heartbeatTimer: null,
    socketUsers: new Map(),
    roomPresence: new Map(),
    socketRegistry: new Map(),
    rateLimitState: new Map(),
    sessionRegistry: new Map(),
    lastEventIds: new Map(),
    ...overrides,
  };
}

function createMockWs(id: string, endpoint = '/ws') {
  const sent: string[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    send(msg: string) {
      sent.push(msg);
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
    },
    subscribe(channel: string) {
      subscribed.push(channel);
    },
    unsubscribe(channel: string) {
      unsubscribed.push(channel);
    },
    data: {
      id,
      endpoint,
      rooms: new Set<string>(),
      actor: { id: null, kind: 'anonymous', tenantId: null, sessionId: null, roles: null, claims: {} },
      requestTenantId: null,
      sessionId: undefined as string | undefined,
    },
    sent,
    subscribed,
    unsubscribed,
    get closed() {
      return closed;
    },
  };
}

describe('wsProtocol — integration', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  it('event + ack round-trip', async () => {
    const handler = mock((_ws: unknown, payload: unknown) => ({ echo: payload }));
    const ws = createMockWs('s1');
    const msg = JSON.stringify({
      action: 'event',
      event: 'echo',
      payload: 'hello',
      ackId: 'ack-1',
    });

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { echo: { handler } },
    });

    expect(consumed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(1);
    const ack = JSON.parse(ws.sent[0]);
    expect(ack).toEqual({ event: 'ack', ackId: 'ack-1', result: { echo: 'hello' } });
  });

  it('fire-and-forget — handler called, no response', async () => {
    const handler = mock(() => 'ignored');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'fire', payload: null });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { fire: { handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(0);
  });

  it('rate limit drop — messages beyond max are dropped', () => {
    const config = { windowMs: 10_000, maxMessages: 2 };
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('drop');
  });

  it('rate limit close — connection close with 1008', () => {
    const config = { windowMs: 10_000, maxMessages: 1, onExceeded: 'close' as const };
    checkRateLimit(state, '/ws', 's1', config);
    const result = checkRateLimit(state, '/ws', 's1', config);
    expect(result).toBe('close');
  });

  it('full dispatch pipeline — room action → typed event → on.message fallthrough', async () => {
    const ws = createMockWs('s1');

    // 1. Room action is consumed
    const subMsg = JSON.stringify({ action: 'subscribe', room: 'lobby' });
    const consumed1 = await handleRoomActions(state, ws as never, subMsg);
    expect(consumed1).toBe(true);
    expect(ws.sent.some(s => JSON.parse(s).event === 'subscribed')).toBe(true);

    // 2. Typed event is consumed
    const handler = mock(() => 'handled');
    const eventMsg = JSON.stringify({
      action: 'event',
      event: 'chat',
      payload: 'hi',
      ackId: 'a1',
    });
    const consumed2 = await handleIncomingEvent(state, ws as never, eventMsg, {
      incoming: { chat: { handler } },
    });
    expect(consumed2).toBe(true);

    // 3. Non-event non-room message falls through
    const plainMsg = JSON.stringify({ type: 'custom', data: 123 });
    const consumed3 = await handleRoomActions(state, ws as never, plainMsg);
    expect(consumed3).toBe(false);
    const consumed4 = await handleIncomingEvent(state, ws as never, plainMsg, {
      incoming: { chat: { handler } },
    });
    expect(consumed4).toBe(false);
    // In server.ts, on.message would be called here
  });

  it('publish with volatile + exclude works together', () => {
    const sockA = {
      id: 'a',
      calls: [] as string[],
      sendText(msg: string) {
        this.calls.push(msg);
        return 1;
      },
    };
    const sockB = {
      id: 'b',
      calls: [] as string[],
      sendText(msg: string) {
        this.calls.push(msg);
        return 0;
      },
    };
    state.socketRegistry.set('a', sockA);
    state.socketRegistry.set('b', sockB);
    const key = encodeURIComponent('/ws') + ':' + encodeURIComponent('room1');
    state.roomRegistry.set(key, new Set(['a', 'b']));

    publish(
      state,
      '/ws',
      'room1',
      { msg: 'test' },
      {
        volatile: true,
        exclude: new Set(['a']),
      },
    );

    expect(sockA.calls).toHaveLength(0); // excluded
    expect(sockB.calls).toHaveLength(1); // called (backpressured but volatile is no-retry)
  });

  it('writeSession + pruneExpiredSessions lifecycle', () => {
    state.lastEventIds.set('s1', 'evt-5');
    writeSession(state, 's1', 'sess-1', new Set(['room1']), 120_000);

    expect(state.sessionRegistry.size).toBe(1);
    const entry = state.sessionRegistry.get('sess-1')!;
    expect(entry.rooms).toEqual(['room1']);
    expect(entry.lastEventId).toBe('evt-5');

    // Add an expired one
    state.sessionRegistry.set('sess-old', {
      rooms: [],
      lastEventId: '',
      expiresAt: Date.now() - 1000,
    });

    pruneExpiredSessions(state);
    expect(state.sessionRegistry.has('sess-old')).toBe(false);
    expect(state.sessionRegistry.has('sess-1')).toBe(true);
  });
});

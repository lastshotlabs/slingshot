import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { handleIncomingEvent } from '../../src/framework/ws/dispatch';
import * as rooms from '../../src/framework/ws/rooms';

// Mock the rooms module so publish/subscribe/unsubscribe are observable
mock.module('../../src/framework/ws/rooms', () => ({
  publish: mock(() => {}),
  subscribe: mock(() => {}),
  unsubscribe: mock(() => {}),
}));

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
  return {
    send(msg: string) {
      sent.push(msg);
    },
    data: { id, endpoint, rooms: new Set<string>(), userId: null },
    sent,
  };
}

describe('wsDispatch — handleIncomingEvent', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  it('known event, no ackId — handler called with correct payload, no send', async () => {
    const handler = mock((_ws: unknown, payload: unknown) => payload);
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'chat', payload: { text: 'hi' } });

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { chat: { handler } },
    });

    expect(consumed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toEqual({ text: 'hi' });
    expect(ws.sent).toHaveLength(0);
  });

  it('known event, ackId — handler called, ack sent with result', async () => {
    const handler = mock(() => 42);
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'add', payload: null, ackId: 'a1' });

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { add: { handler } },
    });

    expect(consumed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a1', result: 42 });
  });

  it('handler returns undefined — ack result is null', async () => {
    const handler = mock(() => undefined);
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'noop', ackId: 'a2' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { noop: { handler } },
    });

    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a2', result: null });
  });

  it('handler throws, ackId — ack error with message', async () => {
    const handler = mock(() => {
      throw new Error('boom');
    });
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'fail', ackId: 'a3' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { fail: { handler } },
    });

    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a3', error: 'boom' });
  });

  it('handler throws, no ackId — console.warn, no send', async () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const handler = mock(() => {
      throw new Error('silent-boom');
    });
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'fail' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { fail: { handler } },
    });

    expect(ws.sent).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    console.warn = originalWarn;
  });

  it('unknown event name — returns true, no send', async () => {
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'unknown-event' });

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { chat: { handler: () => {} } },
    });

    expect(consumed).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it('non-event action — returns false (not consumed)', async () => {
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'subscribe', room: 'test' });

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { chat: { handler: () => {} } },
    });

    expect(consumed).toBe(false);
  });

  it('invalid JSON — returns false (not consumed)', async () => {
    const ws = createMockWs('s1');

    const consumed = await handleIncomingEvent(state, ws as never, 'not-json{', {
      incoming: { chat: { handler: () => {} } },
    });

    expect(consumed).toBe(false);
  });

  it('auth: userAuth, userId present — handler called', async () => {
    state.socketUsers.set('s1', 'user-1');
    const handler = mock(() => 'ok');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'secure', ackId: 'a4' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { secure: { auth: 'userAuth', handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[0]).result).toBe('ok');
  });

  it('auth: userAuth, no userId — ack error unauthenticated (ackId)', async () => {
    const handler = mock(() => 'ok');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'secure', ackId: 'a5' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { secure: { auth: 'userAuth', handler } },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a5', error: 'unauthenticated' });
  });

  it('auth: userAuth, no userId, no ackId — silent drop', async () => {
    const handler = mock(() => 'ok');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'secure' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { secure: { auth: 'userAuth', handler } },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(0);
  });

  it('auth: none (default), no userId — handler called, context.userId is null', async () => {
    const handler = mock((_ws: unknown, _p: unknown, ctx: { userId: string | null }) => ctx.userId);
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'open', ackId: 'a6' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { open: { handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[0]).result).toBeNull();
  });

  it('middleware allow — guard returns true, handler called', async () => {
    const guard = mock(() => true);
    const handler = mock(() => 'allowed');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'guarded', ackId: 'a7' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { guarded: { middleware: ['check'], handler } },
      middleware: { check: guard },
    });

    expect(guard).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[0]).result).toBe('allowed');
  });

  it('middleware deny — guard returns false, ack error forbidden, handler NOT called', async () => {
    const guard = mock(() => false);
    const handler = mock(() => 'should-not-reach');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'guarded', ackId: 'a8' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { guarded: { middleware: ['check'], handler } },
      middleware: { check: guard },
    });

    expect(guard).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a8', error: 'forbidden' });
  });

  it('middleware chain: first denies — second not called, handler not called', async () => {
    const guard1 = mock(() => false);
    const guard2 = mock(() => true);
    const handler = mock(() => 'nope');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'multi', ackId: 'a9' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { multi: { middleware: ['g1', 'g2'], handler } },
      middleware: { g1: guard1, g2: guard2 },
    });

    expect(guard1).toHaveBeenCalledTimes(1);
    expect(guard2).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('middleware throws — treated as deny, ack error forbidden', async () => {
    const guard = mock(() => { throw new Error('guard crash'); });
    const handler = mock(() => 'nope');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'guarded', ackId: 'a-throw' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { guarded: { middleware: ['check'], handler } },
      middleware: { check: guard },
    });

    expect(guard).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a-throw', error: 'forbidden' });
  });

  it('auth: bearer, no userId — ack error unauthenticated', async () => {
    const handler = mock(() => 'ok');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'secure', ackId: 'a-bearer' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { secure: { auth: 'bearer', handler } },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a-bearer', error: 'unauthenticated' });
  });

  it('handler throws non-Error — error message is stringified', async () => {
    const handler = mock(() => { throw 42; });
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'thrownum', ackId: 'a-num' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { thrownum: { handler } },
    });

    expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ack', ackId: 'a-num', error: '42' });
  });

  it('Buffer message is parsed correctly', async () => {
    const handler = mock(() => 'from-buffer');
    const ws = createMockWs('s1');
    const msg = Buffer.from(JSON.stringify({ action: 'event', event: 'buf', ackId: 'a-buf' }));

    const consumed = await handleIncomingEvent(state, ws as never, msg, {
      incoming: { buf: { handler } },
    });

    expect(consumed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[0]).result).toBe('from-buffer');
  });

  it('unknown middleware name — skipped, handler called normally', async () => {
    const handler = mock(() => 'ok');
    const ws = createMockWs('s1');
    const msg = JSON.stringify({ action: 'event', event: 'skip', ackId: 'a10' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { skip: { middleware: ['nonexistent'], handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[0]).result).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // context.publish / context.subscribe / context.unsubscribe (lines 40, 43, 46)
  // -------------------------------------------------------------------------

  it('context.publish is callable from handler (line 40)', async () => {
    const ws = createMockWs('s1');
    const handler = mock((_ws: unknown, _payload: unknown, ctx: any) => {
      ctx.publish('myroom', { hello: 'world' });
      return 'done';
    });
    const msg = JSON.stringify({ action: 'event', event: 'pub', ackId: 'ack-pub' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { pub: { handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    // rooms.publish mock should have been called
    expect((rooms.publish as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  });

  it('context.subscribe is callable from handler (line 43)', async () => {
    const ws = createMockWs('s1');
    (ws as any).subscribe = mock(() => {});
    const handler = mock((_ws: unknown, _payload: unknown, ctx: any) => {
      ctx.subscribe('myroom');
      return 'done';
    });
    const msg = JSON.stringify({ action: 'event', event: 'sub', ackId: 'ack-sub' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { sub: { handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((rooms.subscribe as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  });

  it('context.unsubscribe is callable from handler (line 46)', async () => {
    const ws = createMockWs('s1');
    (ws as any).unsubscribe = mock(() => {});
    const handler = mock((_ws: unknown, _payload: unknown, ctx: any) => {
      ctx.unsubscribe('myroom');
      return 'done';
    });
    const msg = JSON.stringify({ action: 'event', event: 'unsub', ackId: 'ack-unsub' });

    await handleIncomingEvent(state, ws as never, msg, {
      incoming: { unsub: { handler } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((rooms.unsubscribe as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  });
});

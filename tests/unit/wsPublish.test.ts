import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { wsEndpointKey } from '../../src/framework/ws/namespace';
import { publish } from '../../src/framework/ws/rooms';

const ENDPOINT = '/ws';
const ROOM = 'lobby';

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

function createMockSocket(id: string, sendTextReturnValue = 1) {
  const calls: string[] = [];
  return {
    id,
    calls,
    sendText(msg: string) {
      calls.push(msg);
      return sendTextReturnValue;
    },
  };
}

describe('publish() options', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  it('no options — uses server.publish fast path, no per-socket iteration', () => {
    const serverPublish = mock(() => {});
    state.server = { publish: serverPublish };

    // Register a socket in the registry to prove it's NOT iterated
    const sock = createMockSocket('s1');
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    publish(state, ENDPOINT, ROOM, { hello: 'world' });

    expect(serverPublish).toHaveBeenCalledTimes(1);
    expect(serverPublish.mock.calls[0][0]).toBe(key);
    expect(sock.calls).toHaveLength(0); // per-socket NOT used
  });

  it('volatile: true, status 1 — socket receives message; transport called', () => {
    const sock = createMockSocket('s1', 1);
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    const transportPublish = mock(() => Promise.resolve());
    state.transport = {
      publish: transportPublish,
      connect: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
    };

    publish(state, ENDPOINT, ROOM, { data: 1 }, { volatile: true });

    expect(sock.calls).toHaveLength(1);
    expect(transportPublish).toHaveBeenCalledTimes(1);
  });

  it('volatile: true, status 0 — socket does NOT receive message; transport still called', () => {
    const sock = createMockSocket('s1', 0); // backpressure
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    const transportPublish = mock(() => Promise.resolve());
    state.transport = {
      publish: transportPublish,
      connect: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
    };

    publish(state, ENDPOINT, ROOM, { data: 1 }, { volatile: true });

    // sendText was called (returns 0), but the message is effectively dropped
    expect(sock.calls).toHaveLength(1);
    expect(transportPublish).toHaveBeenCalledTimes(1);
  });

  it('exclude: Set(["a"]) — socket a not called, others called, transport called', () => {
    const sockA = createMockSocket('a');
    const sockB = createMockSocket('b');
    state.socketRegistry.set('a', sockA);
    state.socketRegistry.set('b', sockB);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['a', 'b']));

    const transportPublish = mock(() => Promise.resolve());
    state.transport = {
      publish: transportPublish,
      connect: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
    };

    publish(state, ENDPOINT, ROOM, { msg: 'hi' }, { exclude: new Set(['a']) });

    expect(sockA.calls).toHaveLength(0);
    expect(sockB.calls).toHaveLength(1);
    expect(transportPublish).toHaveBeenCalledTimes(1);
  });

  it('volatile + exclude — excluded skipped, remaining dropped on status 0', () => {
    const sockA = createMockSocket('a', 1);
    const sockB = createMockSocket('b', 0); // backpressure
    state.socketRegistry.set('a', sockA);
    state.socketRegistry.set('b', sockB);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['a', 'b']));

    publish(state, ENDPOINT, ROOM, { msg: 'hi' }, { volatile: true, exclude: new Set(['a']) });

    expect(sockA.calls).toHaveLength(0); // excluded
    expect(sockB.calls).toHaveLength(1); // called but backpressured (volatile drop)
  });

  it('socket missing from registry — skipped silently, no error thrown', () => {
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['missing-socket']));

    expect(() => {
      publish(state, ENDPOINT, ROOM, { msg: 'hi' }, { exclude: new Set() });
    }).not.toThrow();
  });

  it('trackDelivery: true — updates lastEventIds[socketId] to the injected message id', () => {
    const sock = createMockSocket('s1');
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    publish(state, ENDPOINT, ROOM, { text: 'hello' }, { trackDelivery: true });

    // The message sent to the socket should carry an injected id.
    expect(sock.calls).toHaveLength(1);
    const sent = JSON.parse(sock.calls[0]);
    expect(typeof sent.id).toBe('string');
    expect(sent.id.length).toBeGreaterThan(0);
    expect(sent.text).toBe('hello');

    // lastEventIds should record that id for the socket.
    expect(state.lastEventIds.get('s1')).toBe(sent.id);
  });

  it('trackDelivery: true with multiple sockets — each socket gets the same id recorded', () => {
    const sockA = createMockSocket('a');
    const sockB = createMockSocket('b');
    state.socketRegistry.set('a', sockA);
    state.socketRegistry.set('b', sockB);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['a', 'b']));

    publish(state, ENDPOINT, ROOM, { n: 1 }, { trackDelivery: true });

    const sentA = JSON.parse(sockA.calls[0]);
    const sentB = JSON.parse(sockB.calls[0]);
    expect(sentA.id).toBe(sentB.id);
    expect(state.lastEventIds.get('a')).toBe(sentA.id);
    expect(state.lastEventIds.get('b')).toBe(sentB.id);
  });

  it('trackDelivery: undefined — lastEventIds unchanged', () => {
    const sock = createMockSocket('s1');
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    // Use volatile to force per-socket path without trackDelivery.
    publish(state, ENDPOINT, ROOM, { text: 'hi' }, { volatile: true });

    expect(state.lastEventIds.size).toBe(0);
  });

  it('transport always fires — both fast path and per-socket path call transport.publish', () => {
    const transportPublish = mock(() => Promise.resolve());
    state.transport = {
      publish: transportPublish,
      connect: mock(() => Promise.resolve()),
      disconnect: mock(() => Promise.resolve()),
    };

    // Fast path
    publish(state, ENDPOINT, ROOM, { a: 1 });
    expect(transportPublish).toHaveBeenCalledTimes(1);

    // Per-socket path
    const sock = createMockSocket('s1');
    state.socketRegistry.set('s1', sock);
    const key = wsEndpointKey(ENDPOINT, ROOM);
    state.roomRegistry.set(key, new Set(['s1']));

    publish(state, ENDPOINT, ROOM, { b: 2 }, { volatile: true });
    expect(transportPublish).toHaveBeenCalledTimes(2);
  });
});

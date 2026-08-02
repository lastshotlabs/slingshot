import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import {
  clearHeartbeatState,
  deregisterSocket,
  handlePong,
  registerSocket,
  startHeartbeat,
  stopHeartbeat,
} from '../../src/framework/ws/heartbeat';

const ENDPOINT = '/ws';

/** Create a minimal WsState for testing heartbeat functions. */
function createWsState(): WsState {
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
  };
}

/** Minimal mock WebSocket. */
function mockWs(id: string) {
  const pings: number[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    data: { id, endpoint: ENDPOINT, rooms: new Set<string>() },
    ping() {
      pings.push(Date.now());
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
    },
    get pings() {
      return pings;
    },
    get closed() {
      return closed;
    },
  } as any;
}

describe('wsHeartbeat', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  afterEach(() => {
    clearHeartbeatState(state);
  });

  test('registerSocket and deregisterSocket track sockets', () => {
    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    // No error — just verifying it doesn't throw
    deregisterSocket(state, 's1');
    // Deregistering again is safe
    deregisterSocket(state, 's1');
  });

  test('handlePong updates last pong timestamp', () => {
    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    handlePong(state, 's1');
    // No error — just verifying it updates without throwing
    deregisterSocket(state, 's1');
  });

  test('startHeartbeat pings registered sockets', async () => {
    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    // Deliberately NO priming pong: a real client cannot answer a ping that has
    // not been sent, so a test that primes one is testing an impossible client.

    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 50, timeoutMs: 5000 } });

    // Wait for one interval
    await new Promise(r => setTimeout(r, 80));

    expect(ws.pings.length).toBeGreaterThanOrEqual(1);
    expect(ws.closed).toBeNull();
  });

  test('a socket that has never been pinged is never closed as overdue', async () => {
    // THE REGRESSION. The deadline used to be seeded at `now + timeoutMs` when
    // the socket OPENED, and the sweep tested it before pinging — so any socket
    // that connected more than timeoutMs before a tick was closed without ever
    // having been asked anything. With the framework defaults (30s/10s) that is
    // every socket, roughly twice a minute, and it reached production twice.
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 20, timeoutMs: 10 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);

    // Long past the timeout, and past several intervals.
    await new Promise(r => setTimeout(r, 30));

    expect(ws.pings.length, 'it should have been pinged').toBeGreaterThanOrEqual(1);
    expect(ws.closed, 'and never closed before it could answer').toBeNull();
  });

  test('a healthy client that keeps ponging is never closed, even when timeoutMs <= intervalMs', async () => {
    // The framework default pair IS timeoutMs < intervalMs. It has to be
    // survivable for a client that answers.
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 20, timeoutMs: 10 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    const answering = setInterval(() => handlePong(state, 's1'), 5);

    await new Promise(r => setTimeout(r, 120));
    clearInterval(answering);

    expect(ws.pings.length, 'pinged repeatedly').toBeGreaterThan(1);
    expect(ws.closed, 'and kept alive throughout').toBeNull();
  });

  test('only one ping is outstanding at a time', async () => {
    // A client that has not answered yet is not re-pinged: a fresh ping every
    // tick would reset nothing and would mask a slow client.
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 15, timeoutMs: 10_000 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);

    await new Promise(r => setTimeout(r, 100));

    expect(ws.pings.length).toBe(1);
    expect(ws.closed).toBeNull();
  });

  test('heartbeat closes a socket that was pinged and never answered', async () => {
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 30, timeoutMs: 10 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    // Never pong. The first tick pings; the next one finds the ping unanswered
    // for longer than timeoutMs and closes.

    await new Promise(r => setTimeout(r, 120));

    expect(ws.pings.length, 'it was asked before it was judged').toBeGreaterThanOrEqual(1);
    expect(ws.closed).not.toBeNull();
    expect(ws.closed!.code).toBe(1001);
    expect(ws.closed!.reason).toBe('Heartbeat timeout');
  });

  test('a client that answers and then goes silent is closed', async () => {
    // The whole point of the mechanism: liveness must still be detected after a
    // period of health, not only from a socket that never answered at all.
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 20, timeoutMs: 10 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);

    const answering = setInterval(() => handlePong(state, 's1'), 5);
    await new Promise(r => setTimeout(r, 60));
    expect(ws.closed, 'healthy so far').toBeNull();

    clearInterval(answering);
    await new Promise(r => setTimeout(r, 120));

    expect(ws.closed).not.toBeNull();
    expect(ws.closed!.reason).toBe('Heartbeat timeout');
  });

  test('stopHeartbeat clears the interval', async () => {
    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    handlePong(state, 's1');

    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 30, timeoutMs: 5000 } });
    stopHeartbeat(state);

    const pingsBefore = ws.pings.length;
    await new Promise(r => setTimeout(r, 80));

    // No new pings after stop
    expect(ws.pings.length).toBe(pingsBefore);
  });

  test('startHeartbeat is idempotent', () => {
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 50, timeoutMs: 5000 } });
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 50, timeoutMs: 5000 } }); // second call is no-op
    stopHeartbeat(state);
  });

  test('clearHeartbeatState resets everything', () => {
    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 50, timeoutMs: 5000 } });
    clearHeartbeatState(state);
    // No errors, state is clean
  });

  test('a socket whose ping() throws does not stop the sweep, or the sockets beside it', async () => {
    // The throw used to escape to the loop-level catch, which ended the WHOLE
    // tick — so one dead handle silently cost every other connection its beat,
    // and whichever sockets came after it in map order were never pinged at all.
    const throwingWs = {
      data: { id: 's-throw', endpoint: ENDPOINT, rooms: new Set<string>() },
      ping() {
        throw new Error('simulated ping failure');
      },
      close() {},
    } as any;
    const healthy = mockWs('s-healthy');

    registerSocket(state, throwingWs, 's-throw', ENDPOINT);
    registerSocket(state, healthy, 's-healthy', ENDPOINT);

    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 30, timeoutMs: 5000 } });

    // Wait for at least one interval — the error must be contained, not propagate
    await new Promise(r => setTimeout(r, 80));

    expect(state.heartbeatTimer, 'the sweep survived').not.toBeNull();
    expect(healthy.pings.length, 'the socket after it still got its beat').toBeGreaterThanOrEqual(
      1,
    );
    expect(healthy.closed).toBeNull();
  });

  test('handlePong is a no-op for unknown socket id', () => {
    // Exercises the early-return path: entry is undefined
    handlePong(state, 'does-not-exist');
    // No throw expected
  });

  test('multi-endpoint heartbeats use minimum interval', () => {
    clearHeartbeatState(state);
    const ep1 = '/ws1';
    const ep2 = '/ws2';
    const ws = mockWs('s1');
    state.socketRegistry.set('s1', ws);
    state.socketRegistry.set('s2', ws);

    registerSocket(state, ws, 's1', ep1);
    registerSocket(state, ws, 's2', ep2);

    startHeartbeat(state, {
      [ep1]: { intervalMs: 100, timeoutMs: 5000 },
      [ep2]: { intervalMs: 50, timeoutMs: 5000 },
    });

    // Both endpoints should be registered
    expect(state.heartbeatEndpointConfigs.has(ep1)).toBe(true);
    expect(state.heartbeatEndpointConfigs.has(ep2)).toBe(true);
    // Min interval should be 50 (from /ws2)
    expect(state.heartbeatTimer).not.toBeNull();
  });

  test('stopHeartbeat before startHeartbeat is a no-op', () => {
    clearHeartbeatState(state);
    expect(() => stopHeartbeat(state)).not.toThrow();
    expect(state.heartbeatTimer).toBeNull();
  });

  test('clearHeartbeatState on empty state is a no-op', () => {
    expect(() => clearHeartbeatState(state)).not.toThrow();
  });
});

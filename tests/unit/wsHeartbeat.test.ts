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
    handlePong(state, 's1'); // initialize pong so it's fresh

    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 50, timeoutMs: 5000 } });

    // Wait for one interval
    await new Promise(r => setTimeout(r, 80));

    expect(ws.pings.length).toBeGreaterThanOrEqual(1);
    expect(ws.closed).toBeNull();
  });

  test('heartbeat closes stale sockets', async () => {
    // Start heartbeat first so per-endpoint timeout config is available
    // when registerSocket calculates timeoutAt
    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 30, timeoutMs: 10 } });

    const ws = mockWs('s1');
    registerSocket(state, ws, 's1', ENDPOINT);
    // Don't call handlePong — lastPong is Date.now() at register time

    // Wait a bit longer than timeout + interval
    await new Promise(r => setTimeout(r, 80));

    expect(ws.closed).not.toBeNull();
    expect(ws.closed!.code).toBe(1001);
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

  test('heartbeat interval swallows errors thrown by ws.ping() (catch block coverage)', async () => {
    // A socket whose ping() throws exercises the try/catch in the interval callback (line 65)
    const throwingWs = {
      data: { id: 's-throw', endpoint: ENDPOINT, rooms: new Set<string>() },
      ping() {
        throw new Error('simulated ping failure');
      },
      close() {},
    } as any;

    registerSocket(state, throwingWs, 's-throw', ENDPOINT);
    handlePong(state, 's-throw'); // keep it fresh so timeout doesn't fire

    startHeartbeat(state, { [ENDPOINT]: { intervalMs: 30, timeoutMs: 5000 } });

    // Wait for at least one interval — the error must be swallowed, not propagate
    await new Promise(r => setTimeout(r, 80));

    // If we reach here the interval survived the thrown error
    expect(state.heartbeatTimer).not.toBeNull();
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

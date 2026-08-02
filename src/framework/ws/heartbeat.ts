import type { ServerWebSocket } from 'bun';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { sweepStalePresence } from './presence';

/**
 * Per-endpoint WebSocket heartbeat configuration.
 *
 * The server sends periodic pings; sockets that fail to respond with a pong
 * within the timeout window are closed automatically.
 */
export interface HeartbeatConfig {
  /** Interval between ping frames in milliseconds (default `30000`). */
  intervalMs?: number;
  /** Maximum time to wait for a pong response in milliseconds (default `10000`). */
  timeoutMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Register a socket with the heartbeat sweep.
 *
 * A freshly-opened socket has NO outstanding ping, so it cannot be overdue.
 * This used to seed a deadline of `now + timeoutMs` instead, which made every
 * connection overdue `timeoutMs` after it opened — before the loop had sent it
 * anything to answer. The sweep then closed sockets it had never pinged, and
 * with the defaults (30s interval, 10s timeout) that was every socket, roughly
 * twice a minute, reported to the client as a 1001 that looks like a network
 * fault. Two apps shipped that to production before it was understood.
 */
export const registerSocket = (
  state: WsState,
  ws: ServerWebSocket<Record<string, unknown>>,
  socketId: string,
  endpoint: string,
): void => {
  state.heartbeatSockets.set(socketId, { ws, endpoint, pendingPingAt: null });
};

export const deregisterSocket = (state: WsState, id: string): void => {
  state.heartbeatSockets.delete(id);
};

/** The client answered: nothing is outstanding until the next ping goes out. */
export const handlePong = (state: WsState, id: string): void => {
  const entry = state.heartbeatSockets.get(id);
  if (!entry) return;
  entry.pendingPingAt = null;
};

export const startHeartbeat = (
  state: WsState,
  configs: Record<string, HeartbeatConfig | boolean>,
): void => {
  if (state.heartbeatTimer) return;

  for (const [endpoint, cfg] of Object.entries(configs)) {
    const opts = typeof cfg === 'object' ? cfg : {};
    state.heartbeatEndpointConfigs.set(endpoint, {
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  const intervals = [...state.heartbeatEndpointConfigs.values()].map(
    c => c.intervalMs ?? DEFAULT_INTERVAL_MS,
  );
  if (intervals.length === 0) return;
  const minInterval = Math.min(...intervals);

  state.heartbeatTimer = setInterval(() => {
    // Wrap in try/catch — an unhandled throw here would stop the interval
    // permanently, silently disabling heartbeats for all future connections.
    try {
      const now = Date.now();
      for (const [, entry] of state.heartbeatSockets) {
        // Per socket, so one dead handle whose ping() or close() throws costs
        // only its own beat. Wrapped only at the loop level, it took every
        // OTHER socket's beat with it for that tick.
        try {
          const timeoutMs =
            state.heartbeatEndpointConfigs.get(entry.endpoint)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const socket = entry.ws as ServerWebSocket<Record<string, unknown>>;
          // Overdue means "we pinged, and the answer never came" — a socket that
          // has not been pinged yet is not overdue, whatever the clock says.
          if (entry.pendingPingAt !== null && now - entry.pendingPingAt >= timeoutMs) {
            socket.close(1001, 'Heartbeat timeout');
            continue;
          }
          // One ping outstanding at a time: re-pinging while the last is still
          // within its window would reset nothing but would hide a slow client.
          if (entry.pendingPingAt === null) {
            socket.ping();
            entry.pendingPingAt = now;
          }
        } catch (e) {
          console.error('[ws] heartbeat beat failed for one socket:', e);
        }
      }
      // Sweep stale presence entries for sockets that disconnected without cleanup
      if (state.presenceEnabled) sweepStalePresence(state);
    } catch (e) {
      console.error('[ws] heartbeat tick error:', e);
    }
  }, minInterval);
};

export const stopHeartbeat = (state: WsState): void => {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer as ReturnType<typeof setInterval>);
    state.heartbeatTimer = null;
  }
};

export const clearHeartbeatState = (state: WsState): void => {
  stopHeartbeat(state);
  state.heartbeatSockets.clear();
  state.heartbeatEndpointConfigs.clear();
};

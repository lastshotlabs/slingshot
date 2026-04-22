import type { ServerWebSocket } from 'bun';
import type { WsState } from '@lastshotlabs/slingshot-core';

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

export const registerSocket = (
  state: WsState,
  ws: ServerWebSocket<Record<string, unknown>>,
  socketId: string,
  endpoint: string,
): void => {
  const timeoutMs = state.heartbeatEndpointConfigs.get(endpoint)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  state.heartbeatSockets.set(socketId, { ws, endpoint, timeoutAt: Date.now() + timeoutMs });
};

export const deregisterSocket = (state: WsState, id: string): void => {
  state.heartbeatSockets.delete(id);
};

export const handlePong = (state: WsState, id: string): void => {
  const entry = state.heartbeatSockets.get(id);
  if (!entry) return;
  const timeoutMs =
    state.heartbeatEndpointConfigs.get(entry.endpoint)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  entry.timeoutAt = Date.now() + timeoutMs;
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

  const minInterval = Math.min(
    ...[...state.heartbeatEndpointConfigs.values()].map(c => c.intervalMs ?? DEFAULT_INTERVAL_MS),
  );

  state.heartbeatTimer = setInterval(() => {
    // Wrap in try/catch — an unhandled throw here would stop the interval
    // permanently, silently disabling heartbeats for all future connections.
    try {
      const now = Date.now();
      for (const [, entry] of state.heartbeatSockets) {
        if (now >= entry.timeoutAt) {
          (entry.ws as ServerWebSocket<Record<string, unknown>>).close(1001, 'Heartbeat timeout');
        } else {
          (entry.ws as ServerWebSocket<Record<string, unknown>>).ping();
        }
      }
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

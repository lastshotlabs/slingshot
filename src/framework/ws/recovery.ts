import type { ServerWebSocket } from 'bun';
import type { WsState } from '@lastshotlabs/slingshot-core';
import type { SocketData } from './index';
import { getMessageHistory } from './messages';
import { wsEndpointKey } from './namespace';
import type { RecoverableEndpointConfig } from './recoveryTypes';

function defaultResubscribe(state: WsState, ws: ServerWebSocket<SocketData>, room: string): void {
  const key = wsEndpointKey(ws.data.endpoint, room);
  ws.data.rooms.add(room);

  let socketIds = state.roomRegistry.get(key);
  if (!socketIds) {
    socketIds = new Set();
    state.roomRegistry.set(key, socketIds);
  }
  socketIds.add(ws.data.id);
  ws.subscribe(key);
}

export async function handleRecover(
  state: WsState,
  ws: ServerWebSocket<SocketData>,
  data: { sessionId: string; rooms: string[]; lastEventId: string },
  endpoint: RecoverableEndpointConfig,
  app: object,
  resubscribe?: (state: WsState, ws: ServerWebSocket<SocketData>, room: string) => void,
): Promise<void> {
  // 1. Prune expired sessions lazily while looking up
  pruneExpiredSessions(state);

  // 2. Look up session
  const session = state.sessionRegistry.get(data.sessionId);
  if (!session || session.expiresAt < Date.now()) {
    ws.send(JSON.stringify({ event: 'recover_failed', reason: 'session_expired' }));
    state.sessionRegistry.delete(data.sessionId);
    return;
  }

  // 3. Validate rooms: order-insensitive set comparison
  const sessionRooms = new Set(session.rooms);
  const requestRooms = new Set(data.rooms);
  const roomsMatch =
    sessionRooms.size === requestRooms.size && [...sessionRooms].every(r => requestRooms.has(r));
  if (!roomsMatch) {
    ws.send(JSON.stringify({ event: 'recover_failed', reason: 'rooms_changed' }));
    return;
  }

  // 4. Persistence check (runtime guard; startup validation catches this at boot)
  if (!endpoint.persistence) {
    ws.send(JSON.stringify({ event: 'recover_failed', reason: 'persistence_unavailable' }));
    return;
  }

  // 5. Re-subscribe and replay
  const restoreSubscription = resubscribe ?? defaultResubscribe;
  let replayed = 0;
  for (const room of session.rooms) {
    restoreSubscription(state, ws, room);
    let messages: Awaited<ReturnType<typeof getMessageHistory>>;
    try {
      messages = await getMessageHistory(ws.data.endpoint, room, { after: data.lastEventId }, app);
    } catch (err) {
      // Abort recovery on any message-history failure so the client sees a
      // deterministic failure rather than a partially-replayed session.
      console.error(`[ws] recovery getMessageHistory failed for room "${room}":`, err);
      ws.send(JSON.stringify({ event: 'recover_failed', reason: 'history_unavailable', room }));
      return;
    }
    for (const msg of messages) {
      ws.send(JSON.stringify(msg.payload));
      state.lastEventIds.set(ws.data.id, msg.id);
      replayed++;
    }
  }

  // 6. Confirm + consume session
  ws.send(JSON.stringify({ event: 'recovered', replayed }));
  state.sessionRegistry.delete(data.sessionId);
}

/**
 * Persists the disconnected socket's session so the client can recover on reconnect.
 *
 * Invariant: `sessionId` is populated in the `open` handler (see `server.ts`) whenever
 * the endpoint has `recovery` configured. Startup validation in `createServer()` guarantees
 * that `recovery` is only active when `persistence` is also configured. Callers in the
 * `close` handler therefore reach this function only on sockets where `ws.data.sessionId`
 * is defined; no runtime guards required here.
 */
export function writeSession(
  state: WsState,
  socketId: string,
  sessionId: string,
  rooms: Set<string>,
  windowMs: number,
): void {
  const lastEventId = state.lastEventIds.get(socketId) ?? '';
  state.sessionRegistry.set(sessionId, {
    rooms: [...rooms],
    lastEventId,
    expiresAt: Date.now() + windowMs,
  });
}

export function pruneExpiredSessions(state: WsState): void {
  const now = Date.now();
  for (const [id, entry] of state.sessionRegistry) {
    if (entry.expiresAt < now) state.sessionRegistry.delete(id);
  }
}

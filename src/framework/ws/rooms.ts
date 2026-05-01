import type { ServerWebSocket } from 'bun';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { isValidRoomName } from '@lastshotlabs/slingshot-core';
import type { SocketData } from './index';
import { wsEndpointKey } from './namespace';
import { addPresence, cleanupPresence, removePresence } from './presence';
import { handleRecover } from './recovery';
import type { RecoverableEndpointConfig } from './recoveryTypes';

type WithRooms = { rooms: Set<string> };
type WithSocketId = { id: string; endpoint: string } & WithRooms;

type RoomGuard<T extends WithRooms> = (
  ws: ServerWebSocket<T>,
  room: string,
) => boolean | Promise<boolean>;

type JsonObject = Record<string, unknown>;
type SubscribeAction = { action: 'subscribe'; room: string };
type UnsubscribeAction = { action: 'unsubscribe'; room: string };
type RecoverAction = {
  action: 'recover';
  sessionId: string;
  rooms: string[];
  lastEventId: string;
};
type RoomAction = SubscribeAction | UnsubscribeAction | RecoverAction;

const MAX_ROOM_ACTION_SIZE = 4096;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function tryAttachMessageId(message: string, messageId: string): string {
  const parsed: unknown = JSON.parse(message);
  if (!isJsonObject(parsed)) return message;
  parsed.id = messageId;
  return JSON.stringify(parsed);
}

function parseRoomActionMessage(raw: string): RoomAction | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed) || typeof parsed.action !== 'string') return null;

  if (parsed.action === 'subscribe' && typeof parsed.room === 'string') {
    return { action: 'subscribe', room: parsed.room };
  }

  if (parsed.action === 'unsubscribe' && typeof parsed.room === 'string') {
    return { action: 'unsubscribe', room: parsed.room };
  }

  if (
    parsed.action === 'recover' &&
    typeof parsed.sessionId === 'string' &&
    isStringArray(parsed.rooms) &&
    typeof parsed.lastEventId === 'string'
  ) {
    return {
      action: 'recover',
      sessionId: parsed.sessionId,
      rooms: parsed.rooms,
      lastEventId: parsed.lastEventId,
    };
  }

  return null;
}

export interface PublishOptions {
  /** Drop message on sockets with full send buffers rather than queuing. Local-instance only. */
  volatile?: boolean;
  /** Skip these socket IDs. Pass sender's socketId for "broadcast except sender". */
  exclude?: ReadonlySet<string>;
  /** When true, track per-socket last-delivered message id for recovery. */
  trackDelivery?: boolean;
}

/**
 * Publish a message to all subscribers of a WebSocket room.
 *
 * Uses Bun's native room broadcast for the fast path. Falls back to
 * per-socket delivery when volatile mode, exclude sets, or delivery
 * tracking are enabled. Also fans out to the cross-instance transport
 * when configured.
 *
 * @param state - Instance-scoped WebSocket state.
 * @param endpoint - The WebSocket endpoint path (e.g. `'/ws'`).
 * @param room - The room name to publish to.
 * @param data - The payload to send (serialised to JSON).
 * @param options - Optional publish behaviour (volatile, exclude, tracking).
 */
export const publish = (
  state: WsState,
  endpoint: string,
  room: string,
  data: unknown,
  options?: PublishOptions,
) => {
  const key = wsEndpointKey(endpoint, room);
  const msg = JSON.stringify(data);

  const usePerSocket =
    options?.volatile === true ||
    (options?.exclude?.size ?? 0) > 0 ||
    options?.trackDelivery === true;

  if (usePerSocket) {
    const socketIds = state.roomRegistry.get(key);
    if (socketIds) {
      let msgToSend = msg;
      let msgId: string | undefined;
      if (options?.trackDelivery) {
        msgId = crypto.randomUUID();
        msgToSend = tryAttachMessageId(msg, msgId);
      }

      for (const socketId of socketIds) {
        if (options?.exclude?.has(socketId)) continue;
        // Cast justified: socketRegistry values are always ServerWebSocket<SocketData>
        // set in server.ts open handler. WsState uses unknown because slingshot-core
        // cannot import Bun types.
        const ws = state.socketRegistry.get(socketId) as
          | { sendText: (s: string) => number }
          | undefined;
        if (!ws) continue;
        const status = ws.sendText(msgToSend);
        // status 0 = backpressure. Volatile: do not retry. Non-volatile: Bun queues automatically.
        // status -1 = socket closing. Socket cleanup will fire in the close handler.
        if (options?.volatile && status === 0) continue;
        if (options?.trackDelivery && msgId) {
          state.lastEventIds.set(`${socketId}\0${room}`, msgId);
        }
      }
    }
  } else {
    // Fast path: native room broadcast. Unchanged from existing behavior.
    (state.server as { publish?: (channel: string, message: string) => void } | null)?.publish?.(
      key,
      msg,
    );
  }

  // Transport fan-out is always unconditional.
  // volatile and exclude are local-instance optimizations - the receiving instance has no
  // knowledge of them and delivers to all its local subscribers normally.
  if (state.transport) {
    state.transport
      .publish(endpoint, room, msg, state.instanceId)
      .catch((error: unknown) => console.error('[ws-transport] publish error:', error));
  }
};

/**
 * List all rooms with at least one subscriber on a given endpoint.
 *
 * @param state - Instance-scoped WebSocket state.
 * @param endpoint - The WebSocket endpoint path.
 * @returns An array of room names.
 */
export const getRooms = (state: WsState, endpoint: string): string[] => {
  const prefix = encodeURIComponent(endpoint) + ':';
  const rooms: string[] = [];
  for (const key of state.roomRegistry.keys()) {
    if (key.startsWith(prefix)) {
      const colonIdx = key.indexOf(':');
      rooms.push(decodeURIComponent(key.slice(colonIdx + 1)));
    }
  }
  return rooms;
};

/**
 * List all socket IDs subscribed to a specific room.
 *
 * @param state - Instance-scoped WebSocket state.
 * @param endpoint - The WebSocket endpoint path.
 * @param room - The room name.
 * @returns An array of socket IDs.
 */
export const getRoomSubscribers = (state: WsState, endpoint: string, room: string): string[] => [
  ...(state.roomRegistry.get(wsEndpointKey(endpoint, room)) ?? []),
];

export const handleRoomActions = async <T extends WithSocketId>(
  state: WsState,
  ws: ServerWebSocket<T>,
  message: string | Buffer,
  onSubscribe?: RoomGuard<T>,
  endpointConfig?: RecoverableEndpointConfig,
  app?: object,
): Promise<boolean> => {
  let raw: string;
  try {
    raw = typeof message === 'string' ? message : Buffer.from(message).toString();
  } catch {
    return false;
  }
  if (raw.length > MAX_ROOM_ACTION_SIZE) return false;

  let data: RoomAction | null;
  try {
    data = parseRoomActionMessage(raw);
  } catch {
    return false;
  }
  if (!data) return false;

  // When the endpoint has recovery configured, presence publishes emitted
  // from subscribe/unsubscribe must track per-socket last-delivered ids so
  // recover can resume correctly after reconnect.
  const trackDelivery = endpointConfig?.recovery ? true : undefined;

  if (data.action === 'subscribe') {
    if (!isValidRoomName(data.room)) return true;
    if (onSubscribe) {
      let allowed: boolean;
      try {
        allowed = await onSubscribe(ws, data.room);
      } catch (error: unknown) {
        console.error(`[ws] onRoomSubscribe guard error for room "${data.room}":`, error);
        allowed = false;
      }
      if (!allowed) {
        ws.send(JSON.stringify({ event: 'subscribe_denied', room: data.room }));
        return true;
      }
    }
    subscribe(state, ws, data.room, { trackDelivery });
    ws.send(JSON.stringify({ event: 'subscribed', room: data.room }));
    return true;
  }

  if (data.action === 'unsubscribe') {
    if (!isValidRoomName(data.room)) return true;
    unsubscribe(state, ws, data.room, { trackDelivery });
    ws.send(JSON.stringify({ event: 'unsubscribed', room: data.room }));
    return true;
  }

  if (endpointConfig?.recovery && app) {
    // Cast justified: T extends WithSocketId, which is a subset of SocketData.
    // handleRecover needs the full SocketData shape for ws.data.id/endpoint access.
    // WsState uses unknown at the slingshot-core boundary.
    await handleRecover(
      state,
      ws as unknown as ServerWebSocket<SocketData>,
      {
        sessionId: data.sessionId,
        rooms: data.rooms,
        lastEventId: data.lastEventId,
      },
      endpointConfig,
      app,
      subscribe,
    );
    return true;
  }
  return false;
};

/**
 * Options forwarded to the presence publish emitted from subscribe/unsubscribe.
 * Currently just `trackDelivery` - set by handleRoomActions when the endpoint
 * has recovery configured so lastEventIds stays in sync for recovery cursors.
 */
interface PresencePublishOptions {
  trackDelivery?: boolean;
}

export const subscribe = <T extends WithSocketId>(
  state: WsState,
  ws: ServerWebSocket<T>,
  room: string,
  options?: PresencePublishOptions,
) => {
  const key = wsEndpointKey(ws.data.endpoint, room);
  // Update local state BEFORE calling ws.subscribe() so that any message arriving
  // on the channel immediately after subscription finds consistent registry state.
  ws.data.rooms.add(room);
  let socketIds = state.roomRegistry.get(key);
  if (!socketIds) {
    socketIds = new Set();
    state.roomRegistry.set(key, socketIds);
  }
  socketIds.add(ws.data.id);
  ws.subscribe(key);

  if (state.presenceEnabled) {
    const result = addPresence(state, ws.data.id, ws.data.endpoint, room);
    if (result?.isNewUser) {
      publish(
        state,
        ws.data.endpoint,
        room,
        {
          event: 'presence_join',
          room,
          userId: result.userId,
        },
        options?.trackDelivery ? { trackDelivery: true } : undefined,
      );
    }
  }
};

export const unsubscribe = <T extends WithSocketId>(
  state: WsState,
  ws: ServerWebSocket<T>,
  room: string,
  options?: PresencePublishOptions,
) => {
  const key = wsEndpointKey(ws.data.endpoint, room);
  // Update local state BEFORE calling ws.unsubscribe() for registry consistency.
  ws.data.rooms.delete(room);
  const ids = state.roomRegistry.get(key);
  if (ids) {
    ids.delete(ws.data.id);
    if (ids.size === 0) state.roomRegistry.delete(key);
  }

  if (state.presenceEnabled) {
    const result = removePresence(state, ws.data.id, ws.data.endpoint, room);
    if (result?.isLastSocket) {
      publish(
        state,
        ws.data.endpoint,
        room,
        {
          event: 'presence_leave',
          room,
          userId: result.userId,
        },
        options?.trackDelivery ? { trackDelivery: true } : undefined,
      );
    }
  }

  ws.unsubscribe(key);
};

/**
 * Get the set of rooms a specific socket is currently subscribed to.
 *
 * @param ws - The server WebSocket instance.
 * @returns An array of room names.
 */
export const getSubscriptions = <T extends WithRooms>(ws: ServerWebSocket<T>): string[] => [
  ...ws.data.rooms,
];

export const cleanupSocket = <T extends WithSocketId>(
  state: WsState,
  ws: ServerWebSocket<T>,
  options?: PresencePublishOptions,
) => {
  if (state.presenceEnabled) {
    const departed = cleanupPresence(state, ws.data.id, ws.data.endpoint, ws.data.rooms);
    for (const { room, userId } of departed) {
      publish(
        state,
        ws.data.endpoint,
        room,
        { event: 'presence_leave', room, userId },
        options?.trackDelivery ? { trackDelivery: true } : undefined,
      );
    }
  }

  for (const room of ws.data.rooms) {
    const key = wsEndpointKey(ws.data.endpoint, room);
    const ids = state.roomRegistry.get(key);
    if (ids) {
      ids.delete(ws.data.id);
      if (ids.size === 0) state.roomRegistry.delete(key);
    }
  }
};

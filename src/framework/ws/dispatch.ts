import type { ServerWebSocket } from 'bun';
import type { WsState } from '@lastshotlabs/slingshot-core';
import type { WsEndpointConfig, WsEventContext } from '../../config/types/ws';
import type { SocketData } from './index';
import { publish, subscribe, unsubscribe } from './rooms';

/** Subset of WsEndpointConfig fields used by dispatch — avoids generic variance issues. */
type DispatchableEndpointConfig = Pick<WsEndpointConfig, 'incoming' | 'middleware'>;

/**
 * Attempt to dispatch an incoming message as a typed event (action: 'event').
 * Returns true if the message was consumed (whether successfully handled or not).
 * Returns false if the message is not a typed event — caller should fall through to on.message.
 */
export async function handleIncomingEvent(
  state: WsState,
  ws: ServerWebSocket<SocketData>,
  raw: string | Buffer,
  endpointConfig: DispatchableEndpointConfig,
): Promise<boolean> {
  // 1. Parse — return false for non-JSON or non-event messages (fall through to on.message)
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString());
  } catch {
    return false;
  }
  if (!isEventAction(data)) return false;

  const { event: eventName, payload, ackId } = data;

  // 2. Unknown event — silently consume (do not fall through to on.message)
  const config = endpointConfig.incoming?.[eventName];
  if (!config) return true;

  const context: WsEventContext = {
    socketId: ws.data.id,
    actorId: state.socketUsers.get(ws.data.id) ?? null,
    endpoint: ws.data.endpoint,
    publish(room: string, data: unknown): void {
      publish(state, ws.data.endpoint, room, data);
    },
    subscribe(room: string): void {
      subscribe(state, ws, room);
    },
    unsubscribe(room: string): void {
      unsubscribe(state, ws, room);
    },
  };

  // 3. Auth check
  if (config.auth === 'userAuth' || config.auth === 'bearer') {
    if (!context.actorId) {
      sendAck(ws, ackId, { error: 'unauthenticated' });
      return true;
    }
  }

  // 4. Middleware chain — first false short-circuits
  for (const name of config.middleware ?? []) {
    const guard = endpointConfig.middleware?.[name];
    if (!guard) continue; // unknown middleware name: skip, do not fail
    let allowed: boolean;
    try {
      allowed = await guard(ws, context);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      sendAck(ws, ackId, { error: 'forbidden' });
      return true;
    }
  }

  // 5. Handler
  try {
    const result = await config.handler(ws, payload, context);
    sendAck(ws, ackId, { result: result ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendAck(ws, ackId, { error: message });
    if (ackId === undefined) {
      console.warn(`[wsDispatch] unhandled error in handler '${eventName}':`, e);
    }
  }

  return true;
}

/** Only sends if ackId is defined — callers pass it unconditionally. */
function sendAck(
  ws: { send: (s: string) => void },
  ackId: string | undefined,
  payload: { result?: unknown } | { error: string },
): void {
  if (ackId !== undefined) {
    ws.send(JSON.stringify({ event: 'ack', ackId, ...payload }));
  }
}

function isEventAction(
  data: unknown,
): data is { action: 'event'; event: string; payload?: unknown; ackId?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).action === 'event' &&
    typeof (data as Record<string, unknown>).event === 'string'
  );
}

import type { HeartbeatConfig } from '@framework/ws/heartbeat';
import type { SocketData } from '@framework/ws/index';
import type { WsMessageDefaults } from '@framework/ws/messages';
import type { WsTransportAdapter } from '@framework/ws/transport';
import type { Server, ServerWebSocket } from 'bun';
import type { WsRateLimitConfig, WsRecoveryConfig } from '@lastshotlabs/slingshot-core';

type WsMessageStore = 'redis' | 'mongo' | 'sqlite' | 'memory';

export type { WsRateLimitConfig, WsRecoveryConfig };

/**
 * Authentication level required for a WebSocket event or endpoint.
 *
 * - `'userAuth'` — requires an authenticated user session.
 * - `'bearer'` — requires a valid bearer token.
 * - `'none'` — no authentication required.
 */
export type WsAuthConfig = 'userAuth' | 'bearer' | 'none';

/**
 * Guard called before each incoming event handler.
 * Returns true to allow, false to deny (ack error 'forbidden' sent if ackId present).
 */
export type WsMiddlewareHandler = (
  ws: ServerWebSocket<SocketData>,
  context: WsEventContext,
) => boolean | Promise<boolean>;

/** Passed to every incoming event handler and middleware. */
export interface WsEventContext {
  /** Stable socket ID assigned by the framework on open. Also the sender ID for exclude. */
  socketId: string;
  /** Authenticated userId from socketUsers map. Null for unauthenticated sockets. */
  userId: string | null;
  /** Endpoint name this socket is connected to. */
  endpoint: string;
  /** Publish a JSON-serialisable payload to a room on this endpoint. */
  publish(room: string, data: unknown): void;
  /** Subscribe this socket to a framework-managed room on this endpoint. */
  subscribe(room: string): void;
  /** Unsubscribe this socket from a framework-managed room on this endpoint. */
  unsubscribe(room: string): void;
}

/**
 * The return value is sent as the ack result when the client included an ackId.
 * Throw to send an ack error response instead.
 * Returning undefined → ack result is null.
 */
export type WsEventHandler = (
  ws: ServerWebSocket<SocketData>,
  payload: unknown,
  context: WsEventContext,
) => unknown;

export interface WsIncomingEventConfig {
  /** Auth level required to send this event. Defaults to 'none'. */
  auth?: WsAuthConfig;
  /**
   * Named middleware run before the handler, in order.
   * Names must match keys in WsEndpointConfig.middleware.
   * First false return short-circuits — handler is not called.
   */
  middleware?: string[];
  handler: WsEventHandler;
}

export interface WsEndpointConfig<T extends object = object> {
  upgrade?: (req: Request, server: Server<SocketData<T>>) => Promise<Response | undefined>;
  on?: {
    open?: (ws: ServerWebSocket<SocketData<T>>) => void | Promise<void>;
    message?: (
      ws: ServerWebSocket<SocketData<T>>,
      message: string | Buffer,
    ) => void | Promise<void>;
    close?: (
      ws: ServerWebSocket<SocketData<T>>,
      code: number,
      reason: string,
    ) => void | Promise<void>;
    drain?: (ws: ServerWebSocket<SocketData<T>>) => void | Promise<void>;
  };
  onRoomSubscribe?: (
    ws: ServerWebSocket<SocketData<T>>,
    room: string,
  ) => boolean | Promise<boolean>;
  maxMessageSize?: number;
  heartbeat?: boolean | HeartbeatConfig;
  presence?: boolean | { broadcastEvents?: boolean };
  persistence?: {
    store?: WsMessageStore;
    defaults?: WsMessageDefaults;
  };
  /** Named event handlers dispatched from action: 'event' messages. */
  incoming?: Record<string, WsIncomingEventConfig>;
  /** Named middleware factories referenced by WsIncomingEventConfig.middleware. */
  middleware?: Record<string, WsMiddlewareHandler>;
  /** Per-connection message rate limit. Applied before all dispatch. */
  rateLimit?: WsRateLimitConfig;
  /**
   * Connection state recovery. Requires persistence to also be configured —
   * createServer() throws at startup if recovery is set without persistence.
   */
  recovery?: WsRecoveryConfig;
}

export interface WsConfig<T extends object = object> {
  endpoints: Record<string, WsEndpointConfig<T>>;
  transport?: WsTransportAdapter;
  idleTimeout?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  perMessageDeflate?: boolean;
  publishToSelf?: boolean;
}

/**
 * Shared WebSocket utility helpers.
 *
 * Extracted to `slingshot-core` so both the framework (`src/framework/lib/ws.ts`)
 * and entity packages (`slingshot-entity`) can import without creating a
 * cross-layer dependency.
 */
import type { ChannelIncomingEventDeclaration } from './entityChannelConfig';

/** Valid WebSocket room name pattern. 1–128 chars: alphanumeric, underscore, colon, dot, slash, hyphen. */
const ROOM_NAME_RE = /^[a-zA-Z0-9_:./-]{1,128}$/;

/**
 * Standard publish function signature for broadcasting to a WebSocket room.
 *
 * Defined in `slingshot-core` so plugins and packages can reference the type
 * without importing from the framework layer (`src/framework/lib/ws.ts`).
 *
 * The concrete implementation lives in the framework and is exposed via
 * `SlingshotContext.wsPublish`. Plugins typically read it lazily from app
 * context rather than threading callback props through package config.
 *
 * @param state - Current WsState from `SlingshotContext.ws`.
 * @param endpoint - WS endpoint name the room belongs to.
 * @param room - Target room name (must pass `isValidRoomName`).
 * @param data - Payload; will be JSON-serialised.
 * @param options - Optional exclude set and volatile/trackDelivery flags.
 */
export type WsPublishFn<TState = unknown> = (
  state: TState,
  endpoint: string,
  room: string,
  data: unknown,
  options?: {
    exclude?: ReadonlySet<string>;
    volatile?: boolean;
    trackDelivery?: boolean;
  },
) => void;

/**
 * Minimal WS endpoint shape that plugins register during `setupPost`.
 *
 * Plugins write `onRoomSubscribe` and `incoming` into
 * `SlingshotContext.wsEndpoints[endpointName]`. The framework's WS message
 * handler reads these fields at connection time, so mutations made during
 * `setupPost` are visible before any client connects.
 *
 * @remarks
 * `incoming` entries are merged with any static handlers already present in
 * the endpoint config. Plugin-registered handlers take precedence on key
 * collision.
 *
 * @example
 * ```ts
 * // In a plugin's setupPost:
 * async setupPost({ app }) {
 *   const ctx = getContext(app);
 *   if (!ctx.wsEndpoints) return;
 *   const ep = ctx.wsEndpoints['my-endpoint'] ??= {};
 *   ep.onRoomSubscribe = async (ws, room) => checkAccess(ws, room);
 *   ep.incoming = { 'cursor.move': { auth: 'userAuth', handler: handleCursor } };
 * }
 * ```
 */
export interface WsPluginEndpoint {
  /**
   * Subscribe guard for this endpoint. When present, replaces any static
   * `onRoomSubscribe` in the endpoint config.
   */
  onRoomSubscribe?: (ws: unknown, room: string) => boolean | Promise<boolean>;
  /**
   * Named incoming event handlers. Merged (plugin handlers take precedence)
   * with any static `incoming` in the endpoint config.
   */
  incoming?: Record<string, ChannelIncomingEventDeclaration>;
  /**
   * Optional lifecycle hooks for the WebSocket endpoint.
   *
   * Plugins write these during `setupPost` to handle connection lifecycle events.
   * The framework reads `on.close` when a WebSocket connection terminates.
   */
  on?: {
    /** Called when a WebSocket connection closes. */
    close?: (ws: unknown, code: number, reason: string) => void | Promise<void>;
  };
}

/**
 * Returns `true` when `room` is a well-formed WebSocket room name.
 *
 * Valid room names are 1–128 characters and may contain only alphanumeric
 * characters, underscores (`_`), colons (`:`), dots (`.`), forward slashes (`/`),
 * and hyphens (`-`). Entity channel rooms follow the convention
 * `{storageName}:{entityId}:{channelName}`.
 *
 * @param room - The candidate room name string.
 * @returns `true` when `room` is a non-empty string matching the allowed pattern,
 *   `false` otherwise.
 *
 * @example
 * ```ts
 * isValidRoomName('containers:abc123:live') // true
 * isValidRoomName('bad room!') // false
 * isValidRoomName('') // false
 * ```
 */
export function isValidRoomName(room: string): boolean {
  return typeof room === 'string' && ROOM_NAME_RE.test(room);
}

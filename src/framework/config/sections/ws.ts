import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for a single WebSocket endpoint definition within `ws.endpoints`.
 *
 * Each key in `ws.endpoints` maps a URL path to one of these descriptors. The
 * framework mounts an HTTP upgrade route at that path and hands upgraded
 * connections to Bun's WebSocket handler configured with these options.
 *
 * @remarks
 * **Fields:**
 * - `upgrade` — Optional Hono middleware `(c: Context, next: Next) => Promise<void>`
 *   executed on the HTTP upgrade request before the connection is established.
 *   Use this to authenticate, attach context data, or reject invalid upgrades.
 * - `on` — Object containing lifecycle callbacks for the WebSocket connection:
 *   - `open(ws)` — Called when a client connects successfully.
 *   - `message(ws, message)` — Called for each inbound message.
 *   - `close(ws, code, reason)` — Called when a client disconnects.
 *   - `drain(ws)` — Called when the send buffer has drained after backpressure.
 *   All handlers are optional; unhandled events are silently ignored.
 * - `onRoomSubscribe` — Hook `(ws, room: string) => boolean | Promise<boolean>`
 *   called when a client subscribes to a pub-sub room. Return `false` to reject
 *   the subscription with a close frame.
 * - `maxMessageSize` — Maximum allowed inbound message size in bytes. Messages
 *   exceeding this are rejected and the connection is closed with code 1009.
 *   Defaults to Bun's built-in default (16 MB).
 * - `heartbeat` — Configures the ping/pong keep-alive mechanism:
 *   - `true` — Enable with default intervals (30 s interval, 10 s timeout).
 *   - `false` — Disable heartbeats.
 *   - Object form: `{ intervalMs?, timeoutMs? }` for explicit values.
 *   Defaults to `true`.
 * - `presence` — Enables presence tracking (connected-user enumeration) for
 *   this endpoint:
 *   - `true` — Enable with default options.
 *   - Object form: `{ broadcastEvents? }`. When `broadcastEvents` is `true`,
 *     join/leave events are broadcast to all room subscribers.
 *   Defaults to `false`.
 * - `persistence` — Configures durable state storage for this WebSocket endpoint:
 *   - `store` — Storage adapter for persisting connection or room state.
 *   - `defaults` — Default state object applied to new connections.
 *
 * @example
 * ```ts
 * ws: {
 *   endpoints: {
 *     '/ws/chat': {
 *       upgrade: authMiddleware,
 *       on: {
 *         open: (ws) => ws.subscribe('global'),
 *         message: (ws, msg) => ws.publish('global', msg),
 *         close: (ws) => ws.unsubscribe('global'),
 *       },
 *       heartbeat: { intervalMs: 15000, timeoutMs: 5000 },
 *       presence: { broadcastEvents: true },
 *     },
 *   },
 * }
 * ```
 */
export const wsEndpointSchema = z.object({
  upgrade: fnSchema.optional(),
  on: z
    .object({
      open: fnSchema.optional(),
      message: fnSchema.optional(),
      close: fnSchema.optional(),
      drain: fnSchema.optional(),
    })
    .loose()
    .optional(),
  onRoomSubscribe: fnSchema.optional(),
  maxMessageSize: z.number().optional(),
  heartbeat: z
    .union([
      z.boolean(),
      z
        .object({
          intervalMs: z.number().optional(),
          timeoutMs: z.number().optional(),
        })
        .loose(),
    ])
    .optional(),
  presence: z
    .union([
      z.boolean(),
      z
        .object({
          broadcastEvents: z.boolean().optional(),
        })
        .loose(),
    ])
    .optional(),
  persistence: z
    .object({
      store: z.any().optional(),
      defaults: z.any().optional(),
    })
    .loose()
    .optional(),
});

/**
 * Zod schema for the `ws` section of `CreateServerConfig`.
 *
 * Enables the WebSocket subsystem and declares all WebSocket endpoints the
 * server exposes. This section is server-only (not available in `CreateAppConfig`).
 *
 * @remarks
 * **Fields:**
 * - `endpoints` — **Required.** Record mapping URL path strings to
 *   {@link wsEndpointSchema} descriptors. Each entry causes the framework to
 *   mount an HTTP upgrade route and register a Bun WebSocket handler at the
 *   specified path.
 * - `transport` — Custom transport adapter replacing the default in-process
 *   pub-sub. Use this to plug in a Redis-backed or other distributed pub-sub
 *   transport for multi-instance deployments. Accepts any object satisfying the
 *   `WsTransport` interface (`z.any()` at the schema level).
 * - `idleTimeout` — Seconds of inactivity after which a connection is
 *   automatically closed. Defaults to Bun's built-in default (120 s). Set to
 *   `0` to disable idle timeouts.
 * - `backpressureLimit` — Maximum number of bytes that may be buffered in the
 *   send queue before `drain` events are fired and further sends block.
 *   Defaults to Bun's built-in default.
 * - `closeOnBackpressureLimit` — When `true`, connections are closed instead of
 *   applying backpressure when the buffer limit is reached. Defaults to `false`.
 * - `perMessageDeflate` — When `true`, enables the `permessage-deflate` WebSocket
 *   compression extension. Reduces bandwidth at the cost of CPU. Defaults to
 *   `false`.
 * - `publishToSelf` — When `true`, a `ws.publish(topic, msg)` call also
 *   delivers the message to the publishing connection's own `message` handler.
 *   Defaults to `false`.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * ws: {
 *   endpoints: {
 *     '/ws/live': {
 *       on: {
 *         open: (ws) => console.log('connected'),
 *         message: (ws, data) => ws.send(data),
 *       },
 *     },
 *   },
 *   idleTimeout: 60,
 *   perMessageDeflate: true,
 * }
 * ```
 */
export const wsSchema = z.object({
  endpoints: z.record(z.string(), wsEndpointSchema.loose()),
  transport: z.any().optional(),
  idleTimeout: z.number().optional(),
  backpressureLimit: z.number().optional(),
  closeOnBackpressureLimit: z.boolean().optional(),
  perMessageDeflate: z.boolean().optional(),
  publishToSelf: z.boolean().optional(),
});

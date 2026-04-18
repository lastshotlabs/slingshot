import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for a single SSE endpoint definition within `sse.endpoints`.
 *
 * Each key in `sse.endpoints` maps a URL path to one of these descriptors.
 * The framework mounts a `GET` route at that path and streams Server-Sent
 * Events matching the configured `events` list.
 *
 * @remarks
 * **Fields:**
 * - `events` — **Required.** Array of event-name strings that this endpoint
 *   will forward to connected clients. Only events whose names are in this list
 *   (and that pass `filter`, if provided) are streamed. Event names must match
 *   keys registered via `bus.registerClientSafeEvents()` — the framework
 *   enforces this at startup to prevent accidental exposure of internal events.
 * - `upgrade` — Optional Hono middleware `(c: Context, next: Next) => Promise<void>`
 *   executed before the SSE connection is established. Use this to authenticate
 *   the request or extract parameters that should be available in `filter`.
 * - `filter` — Optional predicate `(event: BusEvent, c: Context) => boolean`
 *   called for each matching event before it is written to the stream. Return
 *   `false` to suppress delivery to this particular connection (e.g. for
 *   per-user or per-tenant event filtering).
 * - `heartbeat` — Interval in milliseconds at which a no-op comment is sent to
 *   keep the connection alive through proxies. `false` disables heartbeats.
 *   Defaults to 30000 (30 seconds).
 *
 * @example
 * ```ts
 * sse: {
 *   endpoints: {
 *     '/events/notifications': {
 *       events: ['notification.created', 'notification.read'],
 *       upgrade: authMiddleware,
 *       filter: (event, c) => event.payload.userId === c.get('userId'),
 *       heartbeat: 15000,
 *     },
 *   },
 * }
 * ```
 */
export const sseEndpointSchema = z.object({
  events: z.array(z.string()),
  upgrade: fnSchema.optional(),
  filter: fnSchema.optional(),
  heartbeat: z.union([z.number(), z.literal(false)]).optional(),
});

/**
 * Zod schema for the `sse` section of `CreateServerConfig`.
 *
 * Enables the Server-Sent Events subsystem and declares the SSE endpoints the
 * server exposes. This section is server-only (not available in `CreateAppConfig`).
 *
 * @remarks
 * **Fields:**
 * - `endpoints` — **Required.** Record mapping URL path strings to
 *   {@link sseEndpointSchema} descriptors. Each entry causes the framework to
 *   mount a dedicated SSE route at the specified path.
 *
 * **Important constraints:**
 * - Endpoint paths must be unique across `sse.endpoints` and must not collide
 *   with any application routes.
 * - Event names listed in `events` must be registered as client-safe via
 *   `bus.registerClientSafeEvents()` before the server starts. The framework
 *   validates this at startup.
 * - Events in the namespaces `security.*`, `auth:*`, `community:delivery.*`,
 *   `push:*`, and `app:*` cannot be registered as client-safe and will cause a
 *   startup error if referenced here.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * sse: {
 *   endpoints: {
 *     '/events/feed': {
 *       events: ['post.created', 'post.deleted'],
 *       heartbeat: 20000,
 *     },
 *   },
 * }
 * ```
 */
export const sseSchema = z.object({
  endpoints: z.record(z.string(), sseEndpointSchema.loose()),
});

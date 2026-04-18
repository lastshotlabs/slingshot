import type { ClientSafeEventKey } from './eventBus';

/**
 * Data attached to each active SSE connection.
 *
 * The generic parameter `T` allows endpoint-specific metadata to be added at
 * upgrade time (e.g., tenant scope, subscription filters). The base fields
 * (`id`, `userId`, `endpoint`) are always present.
 *
 * @template T - Additional per-connection metadata attached during upgrade.
 */
export type SseClientData<T extends object = object> = {
  /** Unique connection identifier (nanoid). */
  id: string;
  /** Authenticated user ID, or `null` for unauthenticated connections. */
  userId: string | null;
  /** The SSE endpoint name this connection belongs to. */
  endpoint: string;
} & T;

/**
 * Per-client, per-event filter for SSE fanout.
 *
 * Called for each (client, event) pair before delivering a message. Return `false`
 * to suppress delivery to a specific client (e.g., to implement per-user or per-room
 * filtering). Async filters are awaited — keep them fast to avoid fanout latency.
 *
 * @template T - Additional per-connection metadata attached during upgrade.
 * @param client - The SSE client connection metadata.
 * @param event - The event key being delivered.
 * @param payload - The event payload.
 * @returns `true` to deliver the event to this client, `false` to suppress it.
 */
export type SseFilter<T extends object = object> = (
  client: SseClientData<T>,
  event: ClientSafeEventKey,
  payload: unknown,
) => boolean | Promise<boolean>;

/**
 * Configuration for a single SSE endpoint in `CreateServerConfig.sse.endpoints`.
 *
 * Each endpoint specifies which client-safe events it streams, an optional auth/upgrade
 * hook, an optional per-client filter, and a heartbeat interval.
 *
 * @template T - Additional per-connection metadata type attached at upgrade time.
 *
 * @example
 * ```ts
 * const notificationsEndpoint: SseEndpointConfig = {
 *   events: ['community:notification.created'],
 *   heartbeat: 30_000,
 *   filter: (client, _event, payload) => {
 *     return (payload as any).userId === client.userId;
 *   },
 * };
 * ```
 */
export interface SseEndpointConfig<T extends object = object> {
  /** Client-safe event keys this endpoint streams to subscribers. */
  events: ClientSafeEventKey[];
  /**
   * Auth hook called when a client opens an SSE connection.
   * Return `SseClientData<T>` to accept the connection; return a `Response` to reject.
   * When omitted, the framework resolves `userId` from the session cookie/token
   * (permissive — `userId: null` on auth failure, connection still accepted).
   */
  upgrade?: (req: Request) => Promise<SseClientData<T> | Response>;
  /**
   * Per-client, per-event delivery filter.
   * Return `false` to suppress an event for a specific client.
   * Called asynchronously per fanout call — keep it fast.
   */
  filter?: SseFilter<T>;
  /** Keep-alive heartbeat interval in milliseconds. Set to `false` to disable. Default: `30_000`. */
  heartbeat?: number | false;
}

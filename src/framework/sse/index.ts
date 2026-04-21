import { resolveUserId } from '@framework/lib/resolveUserId';
import type {
  EventKey,
  SseClientData,
  SseFilter,
  UserResolver,
} from '@lastshotlabs/slingshot-core';

export type { SseClientData, SseFilter };

// Internal registry entry uses the base shape (T is erased at storage boundary)
interface SseEntry {
  data: SseClientData;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closeHeartbeat: () => void;
}

/**
 * Per-app SSE connection registry.
 *
 * Manages the full lifecycle of Server-Sent Event connections: opening streams,
 * broadcasting events to connected clients, optional per-client filtering, and
 * graceful shutdown. One registry instance is created per app via
 * {@link createSseRegistry} and stored in the app context.
 *
 * All methods are safe to call from any async context — the internal map is
 * updated synchronously and eviction is performed inline on enqueue failure.
 */
export interface SseRegistry {
  /**
   * Open a new SSE stream for a client connection.
   *
   * Creates a `ReadableStream<Uint8Array>` that:
   * 1. Immediately writes a `: connected` comment to flush intermediary proxies.
   * 2. Starts a heartbeat interval (if `heartbeatMs` is not `false`) that writes
   *    `: keep-alive` comments to keep the connection alive through idle periods.
   * 3. Registers the client in the endpoint map so it receives future fanout events.
   * 4. Cleans up automatically on stream cancel (client disconnect).
   *
   * @param endpoint - The route path this client connected on (e.g., `"/events"`).
   *   Used as the fanout routing key — only clients on the same endpoint receive
   *   events sent to that endpoint.
   * @param client - Client metadata including `id`, `userId`, and any custom fields.
   *   The `id` must be unique within the endpoint.
   * @param heartbeatMs - Heartbeat interval in milliseconds, or `false` to disable.
   *   30 000 ms (30 s) is a reasonable default for most production deployments.
   * @returns A `ReadableStream` suitable for returning directly in a Hono response.
   *
   * @example
   * ```ts
   * const stream = registry.createClientStream('/events', client, 30_000);
   * return new Response(stream, {
   *   headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
   * });
   * ```
   */
  createClientStream<T extends object>(
    endpoint: string,
    client: SseClientData<T>,
    heartbeatMs: number | false,
  ): ReadableStream<Uint8Array>;

  /**
   * Broadcast an event to all connected clients on an endpoint.
   *
   * Iterates all clients registered under `endpoint` and writes the SSE frame
   * `event: <key>\ndata: <JSON payload>\n\n` to each. Clients for which the
   * optional `filter` predicate returns `false` are silently skipped.
   *
   * Security: event keys containing `\n` or `\r` are rejected with a console
   * error and no bytes are written. This prevents header injection attacks where
   * a crafted key could synthesize fake SSE frames.
   *
   * If an enqueue call throws (stream closed, client disconnected), the entry is
   * evicted from the registry and its heartbeat timer is cleared.
   *
   * Filter errors are logged and treated as a dropped event — not a denial.
   * Use explicit `false` return values in your filter to deny delivery.
   *
   * @param endpoint - Endpoint path used as the routing key.
   * @param key - Registry-backed event key. Must not contain newline characters.
   * @param payload - Event payload, serialised with `JSON.stringify`.
   * @param filter - Optional async predicate `(client, key, payload) => boolean`.
   *   Called per-client; delivery is skipped when it resolves to `false`.
   */
  fanout(
    endpoint: string,
    key: EventKey,
    payload: unknown,
    filter: SseFilter | undefined,
  ): void;

  /**
   * Close all open SSE streams and clear the registry.
   *
   * Stops all heartbeat timers and closes every active `ReadableStream`
   * controller. Intended for graceful shutdown — call this from `ctx.destroy()`.
   * Errors thrown by individual controller close calls are silently swallowed.
   */
  closeAll(): void;
}

/**
 * Create a new SSE registry for a single app instance.
 *
 * The registry is a closure-owned `Map<endpoint, Map<clientId, SseEntry>>`.
 * No global state is shared between registry instances — each `createApp()`
 * call gets its own registry, satisfying the factory/no-singleton pattern.
 *
 * @returns A fresh {@link SseRegistry} with an empty client map.
 *
 * @example
 * ```ts
 * const registry = createSseRegistry();
 * // Store on SlingshotContext for cross-plugin access:
 * ctx.sseRegistry = registry;
 * ```
 */
export function createSseRegistry(): SseRegistry {
  const map = new Map<string, Map<string, SseEntry>>();
  const enc = new TextEncoder();

  function evict(entry: SseEntry) {
    entry.closeHeartbeat();
    const clients = map.get(entry.data.endpoint);
    if (clients) {
      clients.delete(entry.data.id);
      if (!clients.size) map.delete(entry.data.endpoint);
    }
  }

  function enqueue(entry: SseEntry, chunk: string): boolean {
    try {
      entry.controller.enqueue(enc.encode(chunk));
      return true;
    } catch {
      evict(entry);
      return false;
    }
  }

  return {
    createClientStream(endpoint, client, heartbeatMs) {
      return new ReadableStream({
        start(controller) {
          // Initial comment flushes intermediaries and makes smoke tests feel immediate
          try {
            controller.enqueue(enc.encode(': connected\n\n'));
          } catch {
            // intentional — enqueue may throw if stream is already closed
          }

          let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
          const entry: SseEntry = {
            data: client as SseClientData,
            controller,
            closeHeartbeat: () => clearInterval(heartbeatTimer),
          };
          if (heartbeatMs !== false) {
            heartbeatTimer = setInterval(() => {
              if (!enqueue(entry, ': keep-alive\n\n')) clearInterval(heartbeatTimer);
            }, heartbeatMs);
          }
          if (!map.has(endpoint)) map.set(endpoint, new Map());
          const endpointClients = map.get(endpoint);
          if (endpointClients) endpointClients.set(client.id, entry);
        },
        cancel() {
          const entry = map.get(endpoint)?.get(client.id);
          if (!entry) return;
          evict(entry);
        },
      });
    },

    fanout(endpoint, key, payload, filter) {
      const clients = map.get(endpoint);
      if (!clients?.size) return;
      // Reject event keys containing newlines — they would break SSE framing and
      // allow injection of synthetic events into the client stream.
      if (key.includes('\n') || key.includes('\r')) {
        console.error(
          `[sse] fanout rejected: event key contains newline characters: ${JSON.stringify(key)}`,
        );
        return;
      }
      const text = `event: ${key}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const entry of clients.values()) {
        if (filter) {
          void Promise.resolve(filter(entry.data, key, payload))
            .then(allow => {
              if (allow) enqueue(entry, text);
            })
            .catch((err: unknown) => {
              console.error(
                '[sse] filter error for client',
                entry.data.id,
                '(event dropped, not denied):',
                err,
              );
            });
        } else {
          enqueue(entry, text);
        }
      }
    },

    closeAll() {
      for (const clients of map.values()) {
        for (const entry of clients.values()) {
          entry.closeHeartbeat();
          try {
            entry.controller.close();
          } catch {
            // intentional — controller may already be closed
          }
        }
      }
      map.clear();
    },
  };
}

/**
 * Create the default SSE upgrade handler for an endpoint.
 *
 * Mirrors `createWsUpgradeHandler` in its auth semantics: resolves `userId` from
 * the request's session cookie or bearer token via the optional `userResolver`, then
 * returns a populated {@link SseClientData} object. The upgrade never rejects on auth
 * failure — unauthenticated connections receive `userId: null` and proceed normally.
 * Gate access in a middleware layer or inside your own upgrade wrapper if you need
 * hard rejection.
 *
 * The generic `T` parameter extends the base `SseClientData` shape so you can carry
 * custom fields (e.g., `tenantId`, `roomId`) through the client lifecycle. Those
 * fields must be populated by a wrapping upgrade function — this factory only fills
 * `id`, `userId`, and `endpoint`.
 *
 * @param endpoint - The route path this upgrade handler is mounted on (e.g., `"/events"`).
 *   Stored on `SseClientData.endpoint` and used as the fanout routing key.
 * @param userResolver - Optional custom resolver for extracting the authenticated user ID
 *   from the request. Defaults to the framework's built-in cookie/token resolver when
 *   `null` or omitted.
 * @returns An async upgrade function `(req: Request) => Promise<SseClientData<T>>`.
 *
 * @example
 * ```ts
 * // Basic — uses default auth resolution
 * const upgrade = createSseUpgradeHandler('/events');
 *
 * // Extended — add a custom tenantId field
 * const upgrade = createSseUpgradeHandler<{ tenantId: string }>('/events');
 * const handler = async (req: Request) => ({
 *   ...await upgrade(req),
 *   tenantId: resolveTenantFromRequest(req),
 * });
 * ```
 */
export function createSseUpgradeHandler<T extends object = object>(
  endpoint: string,
  userResolver?: UserResolver | null,
): (req: Request) => Promise<SseClientData<T>> {
  return async (req: Request) => {
    const userId = await resolveUserId(req, userResolver ?? null);
    const data: SseClientData = { id: crypto.randomUUID(), userId, endpoint };
    return data as unknown as SseClientData<T>;
  };
}

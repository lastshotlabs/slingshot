import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import type {
  ClientSafeEventKey,
  EventBusSerializationOptions,
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  FORBIDDEN_CLIENT_PREFIXES,
  JSON_SERIALIZER,
  validateEventPayload,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';

/**
 * Zod schema for `BullMQAdapterOptions`. Validated at adapter-creation time.
 *
 * @remarks
 * The `connection.port` field must be a **number**, not a string. Passing a
 * string (e.g. from an environment variable) will fail validation with a clear
 * message.
 *
 * @example
 * ```ts
 * import { bullmqAdapterOptionsSchema } from '@lastshotlabs/slingshot-bullmq';
 *
 * bullmqAdapterOptionsSchema.parse({
 *   connection: { host: 'localhost', port: 6379 },
 * });
 * ```
 */
export const bullmqAdapterOptionsSchema = z.object({
  /**
   * BullMQ/ioredis connection options. Must be a plain object (not a URL string).
   * `host` must be a string and `port` must be a number when provided.
   */
  connection: z
    .object({
      host: z.string().optional(),
      port: z
        .number({ error: 'connection.port must be a number, not a string' })
        .int()
        .positive()
        .optional(),
    })
    .loose() as z.ZodType<ConnectionOptions>,
  /** Queue name prefix. Default: "slingshot:events" */
  prefix: z.string().optional(),
  /**
   * Number of attempts BullMQ will make before moving a job to the failed set.
   * Applies to all durable subscriptions created by this adapter.
   * Default: 3
   */
  attempts: z.number().int().min(1).optional(),
  /** Event payload validation mode. Default: "off". */
  validation: z.enum(['strict', 'warn', 'off']).optional(),
});

/**
 * Configuration options for `createBullMQAdapter`.
 *
 * @remarks Inferred from `bullmqAdapterOptionsSchema`.
 */
export type BullMQAdapterOptions = z.infer<typeof bullmqAdapterOptionsSchema>;

/**
 * Replaces all colons in `raw` with underscores so the result is safe to use
 * as a BullMQ queue name.
 *
 * BullMQ rejects queue names that contain colons because it uses colons as
 * key separators in Redis. Event keys like `entity:post.created` must be
 * sanitised before being passed to `new Queue()` or `new Worker()`.
 *
 * @param raw - The raw queue name string, potentially containing colons.
 * @returns The sanitised queue name with every `:` replaced by `_`.
 *
 * @example
 * ```ts
 * sanitizeQueueName('slingshot:events:entity:post.created:indexer');
 * // => 'slingshot_events_entity_post.created_indexer'
 * ```
 */
function sanitizeQueueName(raw: string): string {
  return raw.replace(/:/g, '_');
}

/**
 * An entry in the in-memory pending buffer for durable events that failed
 * to reach Redis.
 *
 * @remarks
 * Buffered entries are retried by `drainPendingBuffer` on a `DRAIN_INTERVAL_MS`
 * schedule. Entries that exceed `MAX_ENQUEUE_ATTEMPTS` are dropped with an
 * error log and never recovered.
 */
interface PendingEnqueue {
  /** Internal map key for the durable queue (`prefix:event:name`). */
  name: string;
  /** The BullMQ `Queue` instance to retry the `add` call against. */
  queue: Queue;
  /** The bus event key (e.g. `entity:post.created`). */
  event: string;
  /** The serialised event payload object. */
  payload: object;
  /** Number of enqueue attempts made so far (starts at 1 after the first failure). */
  attempts: number;
}

/**
 * Maximum number of entries the in-memory pending buffer may hold.
 *
 * Once this limit is reached, new durable events that fail to enqueue are
 * **dropped** (with an error log) rather than buffered. This prevents
 * unbounded memory growth during extended Redis outages.
 */
const MAX_PENDING_BUFFER = 1000;

/**
 * Maximum number of enqueue attempts before a buffered event is permanently dropped.
 *
 * After `MAX_ENQUEUE_ATTEMPTS` failures the entry is removed from the pending buffer
 * and an error is logged. The event is lost.
 */
const MAX_ENQUEUE_ATTEMPTS = 5;

/**
 * Interval in milliseconds between drain attempts when the pending buffer is non-empty.
 *
 * When a durable enqueue fails, `scheduleDrain` sets a `setTimeout` for this delay.
 * The drain timer is cancelled on `shutdown()`.
 */
const DRAIN_INTERVAL_MS = 2000;

interface SerializedBullMQEnvelope {
  __slingshot_serialized: string;
  __slingshot_content_type: string;
}

function isSerializedBullMQEnvelope(value: unknown): value is SerializedBullMQEnvelope {
  if (!value || typeof value !== 'object') return false;
  return (
    '__slingshot_serialized' in value &&
    typeof (value as Record<string, unknown>).__slingshot_serialized === 'string' &&
    '__slingshot_content_type' in value &&
    typeof (value as Record<string, unknown>).__slingshot_content_type === 'string'
  );
}

/**
 * Creates a `SlingshotEventBus` implementation backed by BullMQ and Redis.
 *
 * Non-durable subscriptions (`bus.on(event, handler)`) behave identically to
 * the in-process adapter — listeners are called in the same process, fire-and-
 * forget. Durable subscriptions (`bus.on(event, handler, { durable: true,
 * name: 'worker-name' })`) create a BullMQ `Queue` + `Worker` pair. Jobs
 * survive process restarts and are retried up to `opts.attempts` times.
 *
 * **Durability caveat** — if events fail to enqueue (Redis down) they are held
 * in an in-memory pending buffer (up to 1 000 entries) and retried every 2 s.
 * Events in the buffer are lost if the process crashes before they drain. See
 * the inline comment in the source for strategies that eliminate this gap.
 *
 * @param rawOpts - Adapter options (validated with Zod at call time).
 * @returns A `SlingshotEventBus` extended with `_drainPendingBuffer` (internal
 *   test utility — do not call in application code).
 *
 * @throws {Error} If `rawOpts` fails Zod validation.
 *
 * @example
 * ```ts
 * import { createBullMQAdapter } from '@lastshotlabs/slingshot-bullmq';
 *
 * const bus = createBullMQAdapter({
 *   connection: { host: 'localhost', port: 6379 },
 *   attempts: 3,
 * });
 *
 * // Non-durable: fire-and-forget in this process
 * bus.on('entity:post.created', payload => console.log(payload));
 *
 * // Durable: survives restarts, retried on failure
 * bus.on(
 *   'entity:post.created',
 *   async payload => { await processPost(payload); },
 *   { durable: true, name: 'post-indexer' },
 * );
 *
 * // Graceful shutdown (closes all workers and queues)
 * await bus.shutdown();
 * ```
 */
export function createBullMQAdapter(
  rawOpts: BullMQAdapterOptions & EventBusSerializationOptions,
): SlingshotEventBus & { _drainPendingBuffer: () => Promise<void> } {
  const { serializer, schemaRegistry, ...adapterOpts } = rawOpts;
  const opts = validatePluginConfig('slingshot-bullmq', adapterOpts, bullmqAdapterOptionsSchema);
  const prefix = opts.prefix ?? 'slingshot:events';
  const attempts = opts.attempts ?? 3;
  const eventSerializer = serializer ?? JSON_SERIALIZER;
  const validationMode = opts.validation ?? 'off';
  const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();

  // Track durable listeners so off() can detect and reject them
  const durableListeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();

  // Track all created queues and workers for graceful shutdown
  const queues: Queue[] = [];
  const workers: Worker[] = [];

  // Map from internal key ("prefix:event:name") → queue instance
  // Keys use the raw (colon-containing) strings for lookup; actual BullMQ queue
  // names passed to Queue/Worker constructors are sanitized (colons → '_').
  const durableQueues = new Map<string, Queue>();

  // In-memory buffer for events that failed to reach Redis (transient blip, failover).
  //
  // Accepted gap: if the process crashes while events are sitting here, they are lost.
  // This buffer only bridges downtime within a living process. Eliminating the crash
  // gap would require a persistent local write-ahead log (SQLite, append-only file)
  // so buffered events survive a restart — that adds storage dependencies and is out
  // of scope for this adapter.
  //
  // Do not "fix" this by making emit() block or return a Promise. That would require
  // changing SlingshotEventBus.emit() from void → Promise<void> and is a breaking change
  // to the interface.
  //
  // Durability options for applications that cannot tolerate crash-loss:
  //
  //   1. Redis cluster with replication — reduces the probability of Redis downtime
  //      to near-zero; the buffer still protects against short blips.
  //
  //   2. Transactional outbox pattern — eliminates the gap entirely at the application
  //      layer without changing this adapter:
  //        a. Write the event payload to a MongoDB/Postgres "outbox" collection/table
  //           in the same transaction as the domain change (e.g. "order placed").
  //        b. A separate polling process reads unpublished rows, calls bus.emit() /
  //           queue.add(), and marks them published on success.
  //        c. On process crash the outbox rows survive; the poller picks them up after
  //           restart. At-least-once delivery is guaranteed; make consumers idempotent.
  const pendingBuffer: PendingEnqueue[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;

  /**
   * Schedules a drain of the pending buffer after `DRAIN_INTERVAL_MS` if one
   * is not already scheduled or currently in progress.
   *
   * Idempotent — safe to call multiple times; only one timer is ever active
   * at a time. The timer is cleared on `shutdown()`.
   */
  function scheduleDrain(): void {
    if (drainTimer !== null || isDraining) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void drainPendingBuffer();
    }, DRAIN_INTERVAL_MS);
  }

  /**
   * Attempts to re-enqueue all items currently in the pending buffer.
   *
   * Items that succeed are removed from the buffer. Items that fail increment
   * their attempt counter and are kept for the next drain cycle unless
   * `MAX_ENQUEUE_ATTEMPTS` has been reached, in which case they are dropped
   * with an error log. After draining, if any items remain, another drain is
   * scheduled via `scheduleDrain`.
   *
   * Re-entrant calls are no-ops — `isDraining` guards against concurrent execution.
   *
   * @returns A promise that resolves when this drain pass completes.
   *
   * @remarks
   * Exposed on the returned bus object as `_drainPendingBuffer` for integration
   * tests that simulate Redis recovery. Do not call in application code.
   */
  async function drainPendingBuffer(): Promise<void> {
    if (isDraining || pendingBuffer.length === 0) return;
    isDraining = true;
    const retry: PendingEnqueue[] = [];
    for (const item of pendingBuffer) {
      try {
        await item.queue.add(item.event, item.payload);
      } catch (err: unknown) {
        const next = { ...item, attempts: item.attempts + 1 };
        if (next.attempts >= MAX_ENQUEUE_ATTEMPTS) {
          console.error(
            `[BullMQAdapter] dropping durable event "${item.event}" to queue "${item.name}" after ${MAX_ENQUEUE_ATTEMPTS} attempts:`,
            err,
          );
        } else {
          retry.push(next);
        }
      }
    }
    pendingBuffer.length = 0;
    pendingBuffer.push(...retry);
    isDraining = false;
    if (pendingBuffer.length > 0) scheduleDrain();
  }

  const _clientSafeKeys: Set<string> = new Set<string>();

  return {
    get clientSafeKeys(): ReadonlySet<string> {
      return _clientSafeKeys;
    },

    /**
     * Registers a set of event keys as safe to stream to browser clients via SSE.
     *
     * Each key is checked against `FORBIDDEN_CLIENT_PREFIXES` before registration.
     * Multiple calls are additive — already-registered keys are not removed.
     *
     * @param keys - Array of event key strings to mark as client-safe
     *   (e.g. `['entity:post.created', 'entity:comment.updated']`).
     * @returns `void`. Throws synchronously if any key matches a forbidden prefix.
     * @throws {Error} If any key starts with a forbidden namespace prefix
     *   (e.g. `security.*`, `auth:*`).
     */
    registerClientSafeEvents(keys: string[]): void {
      for (const key of keys) {
        const forbidden = FORBIDDEN_CLIENT_PREFIXES.find(p => key.startsWith(p));
        if (forbidden) {
          throw new Error(
            `Cannot register "${key}" as client-safe: "${forbidden}" namespace is forbidden`,
          );
        }
        _clientSafeKeys.add(key);
      }
    },

    /**
     * Validates that `key` is registered as client-safe and returns it as a
     * branded `ClientSafeEventKey`.
     *
     * @param key - The event key to validate (e.g. `'entity:post.created'`).
     * @param source - Optional human-readable label used in error messages to identify
     *   the call site (default: `'SSE config'`).
     * @returns The same `key` value branded as `ClientSafeEventKey`.
     * @throws {Error} If `key` starts with a forbidden namespace prefix.
     * @throws {Error} If `key` has not been registered via `registerClientSafeEvents`.
     */
    ensureClientSafeEventKey(key: string, source = 'SSE config'): ClientSafeEventKey {
      const forbidden = FORBIDDEN_CLIENT_PREFIXES.find(p => key.startsWith(p));
      if (forbidden) {
        throw new Error(
          `[slingshot] ${source}: "${key}" cannot be streamed to clients because the "${forbidden}" namespace is forbidden`,
        );
      }
      if (!_clientSafeKeys.has(key)) {
        throw new Error(
          `[slingshot] ${source}: "${key}" is not registered as client-safe. Call bus.registerClientSafeEvents([...]) before createServer().`,
        );
      }
      return key;
    },

    emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
      const validatedPayload = validateEventPayload(
        event as string,
        payload,
        schemaRegistry,
        validationMode,
      );

      // Fire local (non-durable) listeners synchronously via fire-and-forget.
      // Sync throws are caught separately so subsequent listeners still fire (matches InProcessAdapter).
      const fns = listeners.get(event as string);
      if (fns) {
        for (const fn of Array.from(fns)) {
          let result: void | Promise<void>;
          try {
            result = fn(validatedPayload);
          } catch (err: unknown) {
            console.error(`[BullMQAdapter] listener error on event "${event}":`, err);
            continue;
          }
          Promise.resolve(result).catch((err: unknown) => {
            console.error(`[BullMQAdapter] listener error on event "${event}":`, err);
          });
        }
      }

      // Enqueue to all durable queues for this event; buffer and retry on Redis failure
      const queuePrefix = `${prefix}:${event}`;
      for (const [name, queue] of durableQueues.entries()) {
        if (name.startsWith(queuePrefix + ':')) {
          const durablePayload =
            eventSerializer === JSON_SERIALIZER
              ? (validatedPayload as object)
              : ({
                  __slingshot_serialized: Buffer.from(
                    eventSerializer.serialize(event as string, validatedPayload),
                  ).toString('base64'),
                  __slingshot_content_type: eventSerializer.contentType,
                } satisfies SerializedBullMQEnvelope);
          queue.add(event, durablePayload).catch((err: unknown) => {
            if (pendingBuffer.length >= MAX_PENDING_BUFFER) {
              console.error(
                `[BullMQAdapter] pending buffer full; dropping durable event "${event}" to queue "${name}":`,
                err,
              );
              return;
            }
            pendingBuffer.push({
              name,
              queue,
              event,
              payload: durablePayload,
              attempts: 1,
            });
            scheduleDrain();
          });
        }
      }
    },

    on<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
      subscriptionOpts?: SubscriptionOpts,
    ): void {
      if (subscriptionOpts?.durable === true) {
        if (!subscriptionOpts.name) {
          throw new Error('[BullMQAdapter] durable subscriptions require a name. Pass opts.name.');
        }

        // Internal map key (colons kept for human-readable lookup)
        const mapKey = `${prefix}:${event}:${subscriptionOpts.name}`;
        // Actual BullMQ queue name — colons replaced so BullMQ accepts it
        const bullmqQueueName = sanitizeQueueName(mapKey);

        if (durableQueues.has(mapKey)) {
          throw new Error(
            `[BullMQAdapter] a durable subscription named "${subscriptionOpts.name}" for event "${event}" already exists. Names must be unique per event.`,
          );
        }

        const queue = new Queue(bullmqQueueName, {
          connection: opts.connection,
          defaultJobOptions: { attempts },
        });
        queues.push(queue);
        durableQueues.set(mapKey, queue);

        const worker = new Worker(
          bullmqQueueName,
          async job => {
            let workerPayload: unknown = job.data;
            if (isSerializedBullMQEnvelope(job.data)) {
              workerPayload = eventSerializer.deserialize(
                event as string,
                Buffer.from(job.data.__slingshot_serialized, 'base64'),
              );
            }

            workerPayload = validateEventPayload(
              event as string,
              workerPayload,
              schemaRegistry,
              validationMode,
            );
            await Promise.resolve(listener(workerPayload as SlingshotEventMap[K]));
          },
          { connection: opts.connection },
        );

        worker.on('error', err => {
          console.error(`[BullMQAdapter] worker error on queue "${bullmqQueueName}":`, err);
        });

        worker.on('failed', (job, err) => {
          const attemptsStr = job
            ? `(attempt ${job.attemptsMade}/${attempts})`
            : '(job unavailable)';
          console.error(
            `[BullMQAdapter] job failed on queue "${bullmqQueueName}" ${attemptsStr}:`,
            err,
          );
        });

        workers.push(worker);

        // Track durable listener so off() can detect and reject it
        const key = event as string;
        if (!durableListeners.has(key)) durableListeners.set(key, new Set());
        durableListeners.get(key)?.add(listener as (payload: unknown) => void | Promise<void>);
      } else {
        // Non-durable: register on local typed listener map
        const key = event as string;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key)?.add(listener as (payload: unknown) => void | Promise<void>);
      }
    },

    /**
     * Removes a non-durable listener previously registered with `on()`.
     *
     * @param event - The event key the listener was registered for.
     * @param listener - The exact listener function reference passed to `on()`.
     * @returns `void`.
     * @throws {Error} If `listener` was registered as a durable subscription.
     *   Durable subscriptions cannot be removed individually; use `shutdown()` to
     *   close all workers and queues.
     */
    off<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void,
    ): void {
      const dl = durableListeners.get(event as string);
      if (dl?.has(listener as (payload: unknown) => void | Promise<void>)) {
        throw new Error(
          `[BullMQAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all workers.`,
        );
      }
      listeners
        .get(event as string)
        ?.delete(listener as (payload: unknown) => void | Promise<void>);
    },

    /**
     * Gracefully shuts down all BullMQ workers and queues created by this adapter.
     *
     * Cancels any pending drain timer, clears in-memory listener maps, closes all
     * `Worker` instances (waits for active jobs to finish), and then closes all `Queue`
     * connections. Any events still in the pending buffer at shutdown time are discarded
     * with a warning log.
     *
     * @returns A `Promise` that resolves when all workers and queues have been closed.
     */
    async shutdown(): Promise<void> {
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      if (pendingBuffer.length > 0) {
        console.warn(
          `[BullMQAdapter] shutdown: discarding ${pendingBuffer.length} buffered event(s) that could not be enqueued to Redis. These events will not be retried.`,
        );
        pendingBuffer.length = 0;
      }
      listeners.clear();
      durableListeners.clear();
      await Promise.all(workers.map(w => w.close()));
      await Promise.all(queues.map(q => q.close()));
    },

    /** @internal — exposed for testing only; do not use in application code */
    _drainPendingBuffer: drainPendingBuffer,
  };
}

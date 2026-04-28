import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { ZodError, z } from 'zod';
import type {
  EventBusSerializationOptions,
  EventEnvelope,
  MetricsEmitter,
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  JSON_SERIALIZER,
  createNoopMetricsEmitter,
  createRawEventEnvelope,
  isEventEnvelope,
  validateEventPayload,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';

/**
 * Minimal structured-logger surface used by the adapter. Compatible with
 * `console`, pino, bunyan, or any logger exposing `.warn`/`.error`/`.info`.
 *
 * Each method accepts a structured-context object as the first argument and an
 * optional message string as the second. Implementations are free to ignore
 * either argument.
 */
export interface BullMQAdapterLogger {
  warn: (ctx: Record<string, unknown>, msg?: string) => void;
  error: (ctx: Record<string, unknown>, msg?: string) => void;
  info?: (ctx: Record<string, unknown>, msg?: string) => void;
}

function makeConsoleLogger(): BullMQAdapterLogger {
  const fmt = (msg: string | undefined, ctx: Record<string, unknown>): string => {
    const prefix = '[BullMQAdapter]';
    if (msg) return `${prefix} ${msg} ${JSON.stringify(ctx)}`;
    return `${prefix} ${JSON.stringify(ctx)}`;
  };
  return {
    warn(ctx, msg) {
      console.warn(fmt(msg, ctx));
    },
    error(ctx, msg) {
      console.error(fmt(msg, ctx));
    },
    info(ctx, msg) {
      console.log(fmt(msg, ctx));
    },
  };
}

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
  /**
   * Maximum milliseconds to wait for `queue.add()` before rejecting with a
   * timeout error. Guards against indefinite hangs when Redis is unresponsive.
   * Default: 10_000 (10 seconds).
   */
  enqueueTimeoutMs: z.number().int().positive().optional(),
  /**
   * Name of the validation dead-letter queue. When a strict-mode validation
   * failure occurs inside a durable worker processor, the offending job
   * (payload + error metadata) is enqueued to this queue instead of being
   * retried by BullMQ. If not provided, a default name of
   * `${queueName}:validation-dlq` is derived per source queue. Set to an empty
   * string to disable the DLQ entirely (failures are logged and skipped).
   */
  validationDlqQueueName: z.string().optional(),
  /**
   * Base delay in milliseconds for the first drain retry after an enqueue failure.
   * Subsequent retries use exponential backoff: `drainBaseMs * 2^drainBackoffCount`,
   * capped at `drainMaxMs`. Resets to zero when the buffer drains completely.
   * Default: 2_000.
   */
  drainBaseMs: z.number().int().positive().optional(),
  /**
   * Maximum delay in milliseconds between drain retries (caps the exponential
   * backoff). Default: 30_000.
   */
  drainMaxMs: z.number().int().positive().optional(),
  /**
   * Maximum number of enqueue attempts before a buffered event is permanently
   * dropped from the in-memory pending buffer. Default: 5.
   */
  maxEnqueueAttempts: z.number().int().min(1).optional(),
});

/**
 * Configuration options for `createBullMQAdapter`.
 *
 * @remarks Inferred from `bullmqAdapterOptionsSchema`.
 */
export type BullMQAdapterOptions = z.infer<typeof bullmqAdapterOptionsSchema>;

/**
 * Health snapshot for the BullMQ event bus adapter.
 *
 * `status` is a coarse roll-up derived from the underlying signals:
 *   - `'unhealthy'` when buffered events have been dropped (`bufferDroppedCount > 0`)
 *     or the pending buffer has grown past 100 entries.
 *   - `'degraded'` when there is any pending-buffer pressure (`pendingBufferSize > 0`)
 *     or any worker has paused (`workerPausedCount > 0`) or any validation drops
 *     have been observed.
 *   - `'healthy'` otherwise.
 *
 * Treat `status` as advisory — the raw fields are the source of truth.
 */
export interface BullMQAdapterHealth {
  /** Coarse health roll-up suitable for a higher-level health endpoint. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Number of durable queues currently registered. */
  queueCount: number;
  /** Number of durable workers currently running. */
  workerCount: number;
  /** Number of events currently buffered for retry (waiting for Redis to recover). */
  pendingBufferSize: number;
  /**
   * Total number of jobs currently in the BullMQ "failed" state across all
   * durable queues. Aggregated by iterating each queue's `getJobCounts('failed')`.
   * NOTE: this property is populated only by `getHealthAsync()`. The synchronous
   * `getHealth()` accessor returns a cached snapshot of the last async refresh
   * (or `0` if it has not been refreshed).
   */
  failedJobsCount: number;
  /**
   * Number of jobs that have been routed to the validation DLQ (or dropped
   * because no DLQ is configured) since the adapter was created.
   */
  validationDroppedCount: number;
  /**
   * Number of durable events that were dropped from the in-memory pending
   * buffer because the buffer was full or `maxEnqueueAttempts` was exceeded.
   */
  bufferDroppedCount: number;
  /**
   * Number of times a worker entered a paused state. Currently incremented
   * when a `worker.error` event fires (treated as a transient pause signal).
   */
  workerPausedCount: number;
}

/**
 * Threshold above which a non-empty pending buffer is considered backlogged
 * and the adapter rolls up to `'unhealthy'` instead of `'degraded'`.
 */
const PENDING_BUFFER_UNHEALTHY_THRESHOLD = 100;

function rollUpBullMQStatus(input: {
  pendingBufferSize: number;
  bufferDroppedCount: number;
  workerPausedCount: number;
  validationDroppedCount: number;
}): 'healthy' | 'degraded' | 'unhealthy' {
  if (
    input.bufferDroppedCount > 0 ||
    input.pendingBufferSize > PENDING_BUFFER_UNHEALTHY_THRESHOLD
  ) {
    return 'unhealthy';
  }
  if (
    input.pendingBufferSize > 0 ||
    input.workerPausedCount > 0 ||
    input.validationDroppedCount > 0
  ) {
    return 'degraded';
  }
  return 'healthy';
}

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
 * Error codes that indicate a transient infrastructure condition.
 *
 * These errors are safe to retry — the underlying resource (Redis) is
 * temporarily unavailable but should recover.
 */
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND']);

/**
 * Error codes that indicate a permanent, non-retryable failure.
 *
 * Retrying these will not succeed — the request itself is malformed or the
 * target resource does not exist.
 */
const NON_RETRYABLE_CODES = new Set(['EINVAL', 'ENOENT', 'EACCES', 'EBADF']);

/**
 * Classify whether an error is worth retrying.
 *
 * Returns `true` for transient network/connection errors (`ECONNREFUSED`,
 * `EPIPE`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`). Returns `false` for
 * permanent errors (`EINVAL`, `ENOENT`, etc.) and for anything else —
 * unknown errors default to non-retryable to prevent retry storms.
 *
 * @param err - The error to classify.
 * @returns `true` if the error is likely transient and worth retrying.
 */
/**
 * Reduce an unknown error value to a JSON-friendly shape for structured logs.
 *
 * Prefers `name`, `message`, `code` from `Error`-like objects. Stringifies
 * primitives. Returns `{ value: '<unserializable>' }` if `JSON.stringify`
 * cannot represent the value.
 */
function errInfo(err: unknown): Record<string, unknown> | string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return String(err);
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.message === 'string') out.message = e.message;
  if (typeof e.code === 'string') out.code = e.code;
  if (e.cause !== undefined)
    out.cause = e.cause instanceof Error ? e.cause.message : String(e.cause);
  return out;
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (!code) return false;
  if (NON_RETRYABLE_CODES.has(code)) return false;
  return RETRYABLE_CODES.has(code);
}

/**
 * Wrap `queue.add()` with a per-call timeout so that a hung Redis connection
 * does not block the event loop indefinitely.
 *
 * @param queue - The BullMQ `Queue` to enqueue on.
 * @param name - The job name.
 * @param data - The job data object.
 * @param timeoutMs - Maximum milliseconds to wait before rejecting.
 */
async function addWithTimeout(
  queue: Queue,
  name: string,
  data: object,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    queue.add(name, data),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[BullMQAdapter] queue.add() timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
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
  /** The serialised event envelope object. */
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

/** Default maximum number of enqueue attempts before a buffered event is dropped. */
const DEFAULT_MAX_ENQUEUE_ATTEMPTS = 5;

/** Default base delay in milliseconds for the first drain retry. */
const DEFAULT_DRAIN_BASE_MS = 2000;

/** Default maximum delay in milliseconds between drain retries. */
const DEFAULT_DRAIN_MAX_MS = 30_000;

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
 * Reason a durable event was dropped by `createBullMQAdapter`.
 *
 * - `'buffer-full'` — the in-memory pending buffer reached `MAX_PENDING_BUFFER`
 *   entries; the event was discarded immediately rather than buffered.
 * - `'max-attempts'` — the buffered event exceeded `MAX_ENQUEUE_ATTEMPTS`
 *   consecutive Redis failures and was permanently discarded.
 */
export type BullMQAdapterDropReason = 'buffer-full' | 'max-attempts';

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
 * @param rawOpts - Adapter options (validated with Zod at call time). Accepts
 *   an optional `onDrop` callback that is invoked whenever a durable event is
 *   permanently discarded (buffer-full or max-attempts exceeded). Use this for
 *   metrics, alerts, or dead-letter forwarding.
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
 *   onDrop(event, reason) {
 *     metrics.increment('bullmq.dropped_events', { event, reason });
 *   },
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
  rawOpts: BullMQAdapterOptions &
    EventBusSerializationOptions & {
      onDrop?: (event: string, reason: BullMQAdapterDropReason) => void;
      /**
       * Optional structured logger. Falls back to a `console`-backed logger
       * when omitted. All warn/error paths in the adapter route through this
       * logger with structured context fields.
       */
      logger?: BullMQAdapterLogger;
      /**
       * Optional metrics sink. When provided, the adapter records publish /
       * consume / dlq counters, publish/consume durations, and pending-buffer
       * + worker-paused gauges so operators can wire ad-hoc dashboards
       * without log scraping. Defaults to a no-op emitter.
       */
      metrics?: MetricsEmitter;
    },
): SlingshotEventBus & {
  _drainPendingBuffer: () => Promise<void>;
  getHealth: () => BullMQAdapterHealth;
  getHealthAsync: () => Promise<BullMQAdapterHealth>;
} {
  const {
    serializer,
    schemaRegistry,
    onDrop,
    logger: rawLogger,
    metrics: metricsOpt,
    ...adapterOpts
  } = rawOpts;
  const metrics: MetricsEmitter = metricsOpt ?? createNoopMetricsEmitter();
  const opts = validatePluginConfig('slingshot-bullmq', adapterOpts, bullmqAdapterOptionsSchema);
  const prefix = opts.prefix ?? 'slingshot:events';
  const attempts = opts.attempts ?? 3;
  const enqueueTimeoutMs = opts.enqueueTimeoutMs ?? 10_000;
  const eventSerializer = serializer ?? JSON_SERIALIZER;
  const validationMode = opts.validation ?? 'off';
  const logger: BullMQAdapterLogger = rawLogger ?? makeConsoleLogger();
  const drainBaseMs = opts.drainBaseMs ?? DEFAULT_DRAIN_BASE_MS;
  const drainMaxMs = opts.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS;
  const maxEnqueueAttempts = opts.maxEnqueueAttempts ?? DEFAULT_MAX_ENQUEUE_ATTEMPTS;
  const validationDlqQueueNameOpt = opts.validationDlqQueueName;

  // Counters surfaced via getHealth().
  let validationDroppedCount = 0;
  let bufferDroppedCount = 0;
  let workerPausedCount = 0;
  // Cached failed-jobs aggregate; refreshed by getHealthAsync().
  let failedJobsCount = 0;

  // Cache of validation DLQ queues, keyed by sanitized queue name. Created
  // lazily on first failure so that adapters that never see validation errors
  // do not open extra Redis connections. The actual `Queue` instances are
  // appended to `queues` for unified shutdown.
  const validationDlqs = new Map<string, Queue>();

  const envelopeListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void | Promise<void>>
  >();
  const payloadListenerWrappers = new Map<
    string,
    Map<
      (payload: unknown) => void | Promise<void>,
      (envelope: EventEnvelope) => void | Promise<void>
    >
  >();

  // Track durable listeners so off() can detect and reject them
  const durableListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void | Promise<void>>
  >();

  // Track all created queues and workers for graceful shutdown
  const queues: Queue[] = [];
  const workers: Worker[] = [];

  // Map from internal key ("prefix:event:name") → queue instance
  // Keys use the raw (colon-containing) strings for lookup; actual BullMQ queue
  // names passed to Queue/Worker constructors are sanitized (colons → '_').
  const durableQueues = new Map<string, Queue>();

  function getValidationDlq(sourceQueueName: string): Queue | null {
    // Empty string disables the DLQ; explicit name shares one DLQ across queues.
    if (validationDlqQueueNameOpt === '') return null;
    const dlqName =
      validationDlqQueueNameOpt && validationDlqQueueNameOpt.length > 0
        ? sanitizeQueueName(validationDlqQueueNameOpt)
        : sanitizeQueueName(`${sourceQueueName}:validation-dlq`);
    let dlq = validationDlqs.get(dlqName);
    if (!dlq) {
      dlq = new Queue(dlqName, { connection: opts.connection });
      validationDlqs.set(dlqName, dlq);
      queues.push(dlq);
    }
    return dlq;
  }

  /**
   * Determine whether the given error came from `validateEventPayload` in
   * strict mode. Strict-mode failures are surfaced as a vanilla `Error` whose
   * `cause` is a `ZodError` and whose message starts with the
   * `[EventSchemaRegistry]` prefix.
   */
  function isValidationError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { cause?: unknown; message?: string };
    if (e.cause instanceof ZodError) return true;
    if (typeof e.message === 'string' && e.message.startsWith('[EventSchemaRegistry]')) return true;
    return false;
  }

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
  /** Consecutive drain cycles that left items in the buffer — drives exponential backoff. */
  let drainBackoffCount = 0;

  /**
   * Schedules a drain of the pending buffer using exponential backoff.
   *
   * ### Strategy
   *
   * - The first failure schedules a drain after `drainBaseMs` (default 2 000 ms).
   * - Each subsequent drain that still leaves items in the buffer increments
   *   `drainBackoffCount` and doubles the delay: `drainBaseMs * 2^count`.
   * - The delay is capped at `drainMaxMs` (default 30 000 ms) so retries never
   *   stop entirely while the buffer is non-empty.
   * - When a drain pass empties the buffer, `drainBackoffCount` resets to zero
   *   so a fresh failure starts back at `drainBaseMs`.
   * - The function is idempotent: if a timer is already scheduled or a drain
   *   is in progress, it returns immediately. Only one timer is active at a
   *   time.
   *
   * Tunable via the `drainBaseMs`, `drainMaxMs`, and `maxEnqueueAttempts`
   * adapter options.
   */
  function scheduleDrain(): void {
    if (drainTimer !== null || isDraining) return;
    const delayMs = Math.min(drainMaxMs, drainBaseMs * 2 ** drainBackoffCount);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void drainPendingBuffer();
    }, delayMs);
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
      const drainStart = performance.now();
      try {
        await addWithTimeout(item.queue, item.event, item.payload, enqueueTimeoutMs);
        const queueName = (item.queue as { name?: string }).name ?? item.name;
        metrics.counter('bullmq.publish.count', 1, { queue: queueName });
        metrics.timing('bullmq.publish.duration', performance.now() - drainStart, {
          queue: queueName,
        });
      } catch (err: unknown) {
        if (!isRetryableError(err)) {
          bufferDroppedCount += 1;
          logger.error(
            { event: item.event, queue: item.name, err: errInfo(err) },
            'dropping durable event — non-retryable error',
          );
          continue;
        }
        const next = { ...item, attempts: item.attempts + 1 };
        if (next.attempts >= maxEnqueueAttempts) {
          bufferDroppedCount += 1;
          logger.error(
            {
              event: item.event,
              queue: item.name,
              attempts: maxEnqueueAttempts,
              err: errInfo(err),
            },
            'dropping durable event after max attempts',
          );
          onDrop?.(item.event, 'max-attempts');
        } else {
          retry.push(next);
        }
      }
    }
    pendingBuffer.length = 0;
    pendingBuffer.push(...retry);
    metrics.gauge('bullmq.pending.size', pendingBuffer.length);
    isDraining = false;
    if (pendingBuffer.length > 0) {
      drainBackoffCount += 1;
      scheduleDrain();
    } else {
      drainBackoffCount = 0;
    }
  }

  function registerEnvelopeListener<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
    subscriptionOpts?: SubscriptionOpts,
  ): void {
    const key = event as string;
    if (subscriptionOpts?.durable === true) {
      if (!subscriptionOpts.name) {
        throw new Error('[BullMQAdapter] durable subscriptions require a name. Pass opts.name.');
      }

      const mapKey = `${prefix}:${event}:${subscriptionOpts.name}`;
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

      const consumeStartByJob = new Map<string, number>();

      const worker = new Worker(
        bullmqQueueName,
        async job => {
          if (job.id) consumeStartByJob.set(job.id, performance.now());
          let decoded: unknown = job.data;
          if (isSerializedBullMQEnvelope(job.data)) {
            decoded = eventSerializer.deserialize(
              event as string,
              Buffer.from(job.data.__slingshot_serialized, 'base64'),
            );
          }
          let envelope: unknown;
          if (isEventEnvelope(decoded, event)) {
            envelope = decoded;
          } else {
            // Strict-mode validation throws — capture it here so it does not
            // bubble back to BullMQ as a job error (which would consume all
            // configured retries before landing in the failed set). Validation
            // failures are deterministic: the same payload will fail every
            // retry. Route to the validation DLQ instead.
            let validatedPayload: unknown;
            try {
              validatedPayload = validateEventPayload(
                event as string,
                decoded,
                schemaRegistry,
                validationMode,
              );
            } catch (validationErr: unknown) {
              if (!isValidationError(validationErr)) {
                // Not a validation error; let BullMQ retry as before.
                throw validationErr;
              }
              validationDroppedCount += 1;
              metrics.counter('bullmq.dlq.count', 1, { queue: bullmqQueueName });
              const dlq = getValidationDlq(bullmqQueueName);
              const dlqPayload = {
                event: event as string,
                sourceQueue: bullmqQueueName,
                jobId: job.id,
                originalData: job.data,
                error: errInfo(validationErr),
                droppedAt: new Date().toISOString(),
              };
              if (dlq) {
                try {
                  await addWithTimeout(
                    dlq,
                    `${event as string}:validation-failed`,
                    dlqPayload,
                    enqueueTimeoutMs,
                  );
                  logger.warn(
                    {
                      event: event as string,
                      queue: bullmqQueueName,
                      dlq: dlq.name,
                      jobId: job.id,
                      err: errInfo(validationErr),
                    },
                    'routed strict-validation failure to validation DLQ',
                  );
                } catch (dlqErr: unknown) {
                  // DLQ unreachable — log but still complete the job so it
                  // does not retry indefinitely.
                  logger.error(
                    {
                      event: event as string,
                      queue: bullmqQueueName,
                      dlq: dlq.name,
                      jobId: job.id,
                      err: errInfo(dlqErr),
                      validationErr: errInfo(validationErr),
                    },
                    'failed to enqueue strict-validation failure to DLQ; dropping',
                  );
                }
              } else {
                logger.warn(
                  {
                    event: event as string,
                    queue: bullmqQueueName,
                    jobId: job.id,
                    err: errInfo(validationErr),
                  },
                  'strict-validation failure dropped (no validation DLQ configured)',
                );
              }
              return; // mark job complete, no retry
            }
            envelope = createRawEventEnvelope(
              event as Extract<keyof SlingshotEventMap, string>,
              validatedPayload as SlingshotEventMap[K],
            );
          }
          await Promise.resolve(listener(envelope as EventEnvelope<K>));
        },
        { connection: opts.connection },
      );

      worker.on('error', err => {
        workerPausedCount += 1;
        metrics.gauge('bullmq.worker.paused', 1, { queue: bullmqQueueName });
        logger.error({ queue: bullmqQueueName, err: errInfo(err) }, 'worker error');
      });

      worker.on('completed', job => {
        metrics.counter('bullmq.consume.count', 1, {
          queue: bullmqQueueName,
          result: 'success',
        });
        if (job?.id) {
          const start = consumeStartByJob.get(job.id);
          if (typeof start === 'number') {
            metrics.timing('bullmq.consume.duration', performance.now() - start, {
              queue: bullmqQueueName,
            });
            consumeStartByJob.delete(job.id);
          }
        }
      });

      worker.on('failed', (job, err) => {
        metrics.counter('bullmq.consume.count', 1, {
          queue: bullmqQueueName,
          result: 'failure',
        });
        if (job?.id) {
          const start = consumeStartByJob.get(job.id);
          if (typeof start === 'number') {
            metrics.timing('bullmq.consume.duration', performance.now() - start, {
              queue: bullmqQueueName,
            });
            consumeStartByJob.delete(job.id);
          }
        }
        logger.error(
          {
            queue: bullmqQueueName,
            attempt: job?.attemptsMade ?? null,
            maxAttempts: attempts,
            jobId: job?.id ?? null,
            err: errInfo(err),
          },
          'job failed',
        );
      });

      workers.push(worker);

      if (!durableListeners.has(key)) durableListeners.set(key, new Set());
      durableListeners.get(key)?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);
      return;
    }

    if (!envelopeListeners.has(key)) envelopeListeners.set(key, new Set());
    envelopeListeners.get(key)?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  function unregisterEnvelopeListener<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): void {
    const key = event as string;
    const dl = durableListeners.get(key);
    if (dl?.has(listener as (envelope: EventEnvelope) => void | Promise<void>)) {
      throw new Error(
        `[BullMQAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all workers.`,
      );
    }
    envelopeListeners
      .get(key)
      ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  return {
    emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
      const envelope = isEventEnvelope(payload, event)
        ? payload
        : createRawEventEnvelope(
            event as Extract<keyof SlingshotEventMap, string>,
            validateEventPayload(
              event as string,
              payload,
              schemaRegistry,
              validationMode,
            ) as SlingshotEventMap[K],
          );

      // Fire local (non-durable) listeners synchronously via fire-and-forget.
      // Sync throws are caught separately so subsequent listeners still fire (matches InProcessAdapter).
      const fns = envelopeListeners.get(event as string);
      if (fns) {
        for (const fn of Array.from(fns)) {
          let result: void | Promise<void>;
          try {
            result = fn(envelope as EventEnvelope);
          } catch (err: unknown) {
            logger.error({ event: event as string, err: errInfo(err) }, 'listener error');
            continue;
          }
          Promise.resolve(result).catch((err: unknown) => {
            logger.error({ event: event as string, err: errInfo(err) }, 'listener error');
          });
        }
      }

      // Enqueue to all durable queues for this event; buffer and retry on Redis failure
      const queuePrefix = `${prefix}:${event}`;
      for (const [name, queue] of durableQueues.entries()) {
        if (name.startsWith(queuePrefix + ':')) {
          const durablePayload =
            eventSerializer === JSON_SERIALIZER
              ? (envelope as object)
              : ({
                  __slingshot_serialized: Buffer.from(
                    eventSerializer.serialize(event as string, envelope),
                  ).toString('base64'),
                  __slingshot_content_type: eventSerializer.contentType,
                } satisfies SerializedBullMQEnvelope);
          const queueName = (queue as { name?: string }).name ?? name;
          const publishStart = performance.now();
          addWithTimeout(queue, event as string, durablePayload, enqueueTimeoutMs).then(
            () => {
              metrics.counter('bullmq.publish.count', 1, { queue: queueName });
              metrics.timing('bullmq.publish.duration', performance.now() - publishStart, {
                queue: queueName,
              });
            },
            (err: unknown) => {
              if (pendingBuffer.length >= MAX_PENDING_BUFFER) {
                bufferDroppedCount += 1;
                logger.error(
                  { event: event as string, queue: name, err: errInfo(err) },
                  'pending buffer full; dropping durable event',
                );
                onDrop?.(event as string, 'buffer-full');
                return;
              }
              pendingBuffer.push({
                name,
                queue,
                event,
                payload: durablePayload,
                attempts: 1,
              });
              metrics.gauge('bullmq.pending.size', pendingBuffer.length);
              scheduleDrain();
            },
          );
        }
      }
    },

    on<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
      subscriptionOpts?: SubscriptionOpts,
    ): void {
      const key = event as string;
      const wrapper = (envelope: EventEnvelope): void | Promise<void> =>
        listener(envelope.payload as SlingshotEventMap[K]);
      let wrappers = payloadListenerWrappers.get(key);
      if (!wrappers) {
        wrappers = new Map();
        payloadListenerWrappers.set(key, wrappers);
      }
      wrappers.set(listener as (payload: unknown) => void | Promise<void>, wrapper);
      registerEnvelopeListener(
        event,
        wrapper as (envelope: EventEnvelope<K>) => void | Promise<void>,
        subscriptionOpts,
      );
    },

    onEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
      subscriptionOpts?: SubscriptionOpts,
    ): void {
      registerEnvelopeListener(event, listener, subscriptionOpts);
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
      const wrappers = payloadListenerWrappers.get(event as string);
      const wrapper = wrappers?.get(listener as (payload: unknown) => void | Promise<void>);
      if (!wrapper) {
        return;
      }
      const dl = durableListeners.get(event as string);
      if (dl?.has(wrapper as (envelope: EventEnvelope) => void | Promise<void>)) {
        throw new Error(
          `[BullMQAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all workers.`,
        );
      }
      wrappers?.delete(listener as (payload: unknown) => void | Promise<void>);
      if (wrappers?.size === 0) {
        payloadListenerWrappers.delete(event as string);
      }
      unregisterEnvelopeListener(event, wrapper as (envelope: EventEnvelope<K>) => void);
    },

    offEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void,
    ): void {
      unregisterEnvelopeListener(event, listener);
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
        // Keep the legacy console.warn so existing tests that match
        // "discarding" against console output continue to work.
        console.warn(
          `[BullMQAdapter] shutdown: discarding ${pendingBuffer.length} buffered event(s) that could not be enqueued to Redis. These events will not be retried.`,
        );
        logger.warn({ discarded: pendingBuffer.length }, 'shutdown: discarding buffered events');
        pendingBuffer.length = 0;
      }
      envelopeListeners.clear();
      payloadListenerWrappers.clear();
      durableListeners.clear();
      await Promise.all(workers.map(w => w.close()));
      await Promise.all(queues.map(q => q.close()));
    },

    /** @internal — exposed for testing only; do not use in application code */
    _drainPendingBuffer: drainPendingBuffer,

    getHealth(): BullMQAdapterHealth {
      return {
        status: rollUpBullMQStatus({
          pendingBufferSize: pendingBuffer.length,
          bufferDroppedCount,
          workerPausedCount,
          validationDroppedCount,
        }),
        queueCount: queues.length,
        workerCount: workers.length,
        pendingBufferSize: pendingBuffer.length,
        failedJobsCount,
        validationDroppedCount,
        bufferDroppedCount,
        workerPausedCount,
      };
    },

    /**
     * Async variant of `getHealth()` that refreshes `failedJobsCount` by
     * aggregating `getJobCounts('failed')` across every durable queue. The
     * result is cached so subsequent synchronous `getHealth()` calls return
     * the freshly observed value until the next async refresh.
     *
     * @remarks Calling this requires Redis round-trips per queue. Use
     *   `getHealth()` for hot-path checks and `getHealthAsync()` for
     *   periodic monitoring.
     */
    async getHealthAsync(): Promise<BullMQAdapterHealth> {
      let total = 0;
      for (const q of queues) {
        const counts = (
          q as Queue & {
            getJobCounts?: (...statuses: string[]) => Promise<Record<string, number>>;
          }
        ).getJobCounts;
        if (typeof counts !== 'function') continue;
        try {
          const result = await counts.call(q, 'failed');
          const failed = (result as { failed?: number })?.failed;
          if (typeof failed === 'number') total += failed;
        } catch (err: unknown) {
          logger.warn(
            { queue: (q as { name?: string }).name ?? null, err: errInfo(err) },
            'getJobCounts failed during health refresh',
          );
        }
      }
      failedJobsCount = total;
      return {
        status: rollUpBullMQStatus({
          pendingBufferSize: pendingBuffer.length,
          bufferDroppedCount,
          workerPausedCount,
          validationDroppedCount,
        }),
        queueCount: queues.length,
        workerCount: workers.length,
        pendingBufferSize: pendingBuffer.length,
        failedJobsCount,
        validationDroppedCount,
        bufferDroppedCount,
        workerPausedCount,
      };
    },
  };
}

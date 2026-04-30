import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { ZodError, z } from 'zod';
import type {
  EventBusSerializationOptions,
  EventEnvelope,
  HealthReport,
  HealthState,
  Logger,
  MetricsEmitter,
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  JSON_SERIALIZER,
  TimeoutError,
  createConsoleLogger,
  createNoopMetricsEmitter,
  createRawEventEnvelope,
  isEventEnvelope,
  validateEventPayload,
  validatePluginConfig,
  withTimeout,
} from '@lastshotlabs/slingshot-core';
import {
  DuplicateDurableSubscriptionError,
  DurableSubscriptionNameRequiredError,
  DurableSubscriptionOffError,
} from './errors';

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
  connection: (
    z
      .object({
        host: z.string().optional(),
        port: z
          .number({ error: 'connection.port must be a number, not a string' })
          .int()
          .positive()
          .optional(),
      })
      .loose() as z.ZodType<ConnectionOptions>
  ).describe('BullMQ/ioredis connection options; must be a plain object (not a URL string)'),
  /** Queue name prefix. Default: "slingshot:events" */
  prefix: z.string().optional().describe('Queue name prefix (default: "slingshot:events")'),
  /**
   * Number of attempts BullMQ will make before moving a job to the failed set.
   * Applies to all durable subscriptions created by this adapter.
   * Default: 3
   */
  attempts: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Number of attempts BullMQ will make before moving a job to the failed set (default: 3)',
    ),
  /** Event payload validation mode. Default: "off". */
  validation: z
    .enum(['strict', 'warn', 'off'])
    .optional()
    .describe('Event payload validation mode (default: "off")'),
  /**
   * Maximum milliseconds to wait for `queue.add()` before rejecting with a
   * timeout error. Guards against indefinite hangs when Redis is unresponsive.
   * Default: 10_000 (10 seconds).
   */
  enqueueTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds to wait for queue.add() before rejecting with a timeout error (default: 10000)',
    ),
  /**
   * Name of the validation dead-letter queue. When a strict-mode validation
   * failure occurs inside a durable worker processor, the offending job
   * (payload + error metadata) is enqueued to this queue instead of being
   * retried by BullMQ. If not provided, a default name of
   * `${queueName}:validation-dlq` is derived per source queue. Set to an empty
   * string to disable the DLQ entirely (failures are logged and skipped).
   */
  validationDlqQueueName: z
    .string()
    .optional()
    .describe(
      'Name of the validation dead-letter queue; defaults to ${queueName}:validation-dlq. Set to empty string to disable',
    ),
  /**
   * Base delay in milliseconds for the first drain retry after an enqueue failure.
   * Subsequent retries use exponential backoff: `drainBaseMs * 2^drainBackoffCount`,
   * capped at `drainMaxMs`. Resets to zero when the buffer drains completely.
   * Default: 2_000.
   */
  drainBaseMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Base delay in milliseconds for the first drain retry after an enqueue failure; subsequent retries use exponential backoff (default: 2000)',
    ),
  /**
   * Maximum delay in milliseconds between drain retries (caps the exponential
   * backoff). Default: 30_000.
   */
  drainMaxMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum delay in milliseconds between drain retries, capping the exponential backoff (default: 30000)',
    ),
  /**
   * Maximum number of enqueue attempts before a buffered event is permanently
   * dropped from the in-memory pending buffer. Default: 5.
   */
  maxEnqueueAttempts: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Maximum number of enqueue attempts before a buffered event is permanently dropped (default: 5)',
    ),
  /**
   * Optional path to a JSON-lines write-ahead log used to persist buffered
   * events across process restarts. When set, every entry appended to the
   * in-memory pending buffer is first written here. On adapter creation the
   * file is replayed back into the buffer so events survive crashes during
   * transient Redis outages.
   *
   * Disabled by default — opt in by supplying a path. The file grows
   * append-only; a compaction pass runs whenever the live entry count exceeds
   * `walCompactThreshold` (default 1024).
   */
  walPath: z
    .string()
    .optional()
    .describe(
      'Path to a JSON-lines write-ahead log for persisting buffered events across process restarts; disabled by default',
    ),
  /**
   * Number of live entries above which the WAL file is rewritten to discard
   * tombstones for already-consumed events. Default: 1024.
   */
  walCompactThreshold: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of live WAL entries above which the file is rewritten to discard tombstones (default: 1024)',
    ),
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
   * durable queues, as observed by the most recent `checkHealth()` probe.
   * `null` when no probe has run yet — callers should treat that as
   * "unknown" and not as zero. Do not derive alerts from a stale read.
   */
  failedJobsCount: number | null;
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
  /** Number of `enqueue-timeout` events observed since adapter creation. */
  enqueueTimeoutCount: number;
  /** Number of `permanent-error` events observed since adapter creation. */
  permanentErrorCount: number;
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
  permanentErrorCount: number;
}): 'healthy' | 'degraded' | 'unhealthy' {
  if (
    input.bufferDroppedCount > 0 ||
    input.permanentErrorCount > 0 ||
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
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND']);

/**
 * Error codes that indicate a permanent, non-retryable failure.
 *
 * Retrying these will not succeed — the request itself is malformed or the
 * target resource does not exist.
 */
const NON_RETRYABLE_CODES = new Set([
  'EINVAL',
  'ENOENT',
  'EACCES',
  'EBADF',
  'WRONGTYPE',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);

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

type ErrorClassification = 'retryable' | 'permanent' | 'unknown' | 'timeout';

/**
 * Classify an error into one of four buckets:
 *
 *  - `timeout` — the wrapper {@link TimeoutError}. Treated as retryable so the
 *    caller can decide whether to buffer.
 *  - `permanent` — codes in {@link NON_RETRYABLE_CODES}. The caller should
 *    surface a `permanent-error` signal and not buffer.
 *  - `retryable` — codes in {@link RETRYABLE_CODES}. Safe to buffer.
 *  - `unknown` — anything else. The caller decides based on policy; the
 *    default in this adapter is to buffer and let the drain re-classify.
 */
function classifyError(err: unknown): ErrorClassification {
  if (err instanceof TimeoutError) return 'timeout';
  if (!err || typeof err !== 'object') return 'unknown';
  const code = (err as { code?: string }).code;
  if (typeof code === 'string') {
    if (NON_RETRYABLE_CODES.has(code)) return 'permanent';
    if (RETRYABLE_CODES.has(code)) return 'retryable';
  }
  // Some libraries surface a redis WRONGTYPE error in `.message` rather than `.code`.
  const message = (err as { message?: string }).message;
  if (typeof message === 'string' && message.startsWith('WRONGTYPE')) return 'permanent';
  return 'unknown';
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
  /** Stable monotonic id used to mark this entry consumed in the WAL. */
  id: number;
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

/** Default WAL compaction threshold (live entries). */
const DEFAULT_WAL_COMPACT_THRESHOLD = 1024;

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
 * - `'enqueue-timeout'` — the initial `queue.add()` exceeded
 *   `enqueueTimeoutMs` and was buffered for retry; raised as a drop signal so
 *   operators see the timeout, even though the event itself is not yet lost.
 * - `'permanent-error'` — `queue.add()` rejected with a non-retryable error
 *   (e.g. EINVAL, WRONGTYPE). The event is not buffered.
 */
export type BullMQAdapterDropReason =
  | 'buffer-full'
  | 'max-attempts'
  | 'enqueue-timeout'
  | 'permanent-error';

/** Detailed drop event surfaced via the `onDropEvent` callback. */
export interface BullMQAdapterDropEvent {
  reason: BullMQAdapterDropReason;
  event: string;
  queue: string;
  error?: unknown;
}

/**
 * WAL record format. One JSON object per line. `op: 'append'` records a new
 * pending entry; `op: 'consume'` marks a previously appended entry as
 * successfully drained.
 */
interface WalAppendRecord {
  op: 'append';
  id: number;
  name: string;
  event: string;
  payload: object;
}
interface WalConsumeRecord {
  op: 'consume';
  id: number;
}
type WalRecord = WalAppendRecord | WalConsumeRecord;

/**
 * Append-only JSON-lines WAL backing the in-memory pending buffer.
 *
 * Writes are serialised through a single in-flight promise so concurrent
 * `append`/`consume` calls cannot interleave bytes mid-line. Compaction
 * rewrites the file with only the still-live records when the live count
 * exceeds the configured threshold.
 */
class PendingBufferWal {
  private writeChain: Promise<void> = Promise.resolve();
  private liveCount = 0;
  private readonly compactThreshold: number;

  constructor(
    private readonly filePath: string,
    compactThreshold: number,
    private readonly logger: Logger,
  ) {
    this.compactThreshold = compactThreshold;
  }

  /**
   * Replay the WAL into a list of pending entries. Records whose append has a
   * matching consume are filtered out. Returns the entries in append order.
   * Missing files yield an empty list.
   */
  async load(): Promise<Array<{ id: number; name: string; event: string; payload: object }>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        return [];
      }
      throw err;
    }
    const live = new Map<number, { id: number; name: string; event: string; payload: object }>();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec: WalRecord;
      try {
        rec = JSON.parse(line) as WalRecord;
      } catch (err: unknown) {
        this.logger.warn('skipping unparseable WAL line', { err: errInfo(err) });
        continue;
      }
      if (rec.op === 'append') {
        live.set(rec.id, {
          id: rec.id,
          name: rec.name,
          event: rec.event,
          payload: rec.payload,
        });
      } else if (rec.op === 'consume') {
        live.delete(rec.id);
      }
    }
    this.liveCount = live.size;
    return Array.from(live.values());
  }

  append(entry: { id: number; name: string; event: string; payload: object }): Promise<void> {
    const rec: WalAppendRecord = {
      op: 'append',
      id: entry.id,
      name: entry.name,
      event: entry.event,
      payload: entry.payload,
    };
    this.liveCount += 1;
    return this.enqueueWrite(JSON.stringify(rec) + '\n');
  }

  consume(id: number): Promise<void> {
    const rec: WalConsumeRecord = { op: 'consume', id };
    this.liveCount = Math.max(0, this.liveCount - 1);
    const writeP = this.enqueueWrite(JSON.stringify(rec) + '\n');
    if (this.liveCount > this.compactThreshold) {
      return writeP.then(() => this.compact());
    }
    return writeP;
  }

  /** Wait for any pending writes to flush. */
  flush(): Promise<void> {
    return this.writeChain.catch(() => undefined);
  }

  private enqueueWrite(line: string): Promise<void> {
    const next = this.writeChain.then(() => fs.appendFile(this.filePath, line, 'utf8'));
    this.writeChain = next.catch(err => {
      this.logger.error('WAL write failed', { err: errInfo(err) });
    });
    return next;
  }

  /**
   * Rewrite the WAL with a snapshot of the still-live append records. Runs
   * after a write and is itself serialised through `writeChain`.
   */
  private compact(): Promise<void> {
    const next = this.writeChain.then(async () => {
      const live = await this.load();
      this.liveCount = live.length;
      const snapshot = live
        .map(entry =>
          JSON.stringify({
            op: 'append' as const,
            id: entry.id,
            name: entry.name,
            event: entry.event,
            payload: entry.payload,
          }),
        )
        .join('\n');
      const tmp = `${this.filePath}.tmp`;
      const body = snapshot ? `${snapshot}\n` : '';
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    this.writeChain = next.catch(err => {
      this.logger.error('WAL compaction failed', { err: errInfo(err) });
    });
    return next;
  }
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
 * The buffer is process-local. Set `walPath` to opt into a JSON-lines
 * write-ahead log; entries written there are replayed on adapter creation so
 * events survive a process crash during a Redis outage.
 *
 * @param rawOpts - Adapter options (validated with Zod at call time). Accepts
 *   an optional `onDrop` callback that is invoked whenever a durable event is
 *   permanently discarded (buffer-full / max-attempts / permanent-error /
 *   enqueue-timeout). Use this for metrics, alerts, or dead-letter forwarding.
 * @returns A `SlingshotEventBus` extended with `_drainPendingBuffer` (internal
 *   test utility — do not call in application code) and a `HealthCheck`
 *   surface (`getHealth()` cached, `checkHealth()` live probe).
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
       * Optional structured logger (see `Logger` from
       * `@lastshotlabs/slingshot-core`). Defaults to a console-backed JSON
       * logger when omitted. All warn/error paths in the adapter route
       * through this logger with structured context fields.
       */
      logger?: Logger;
      /**
       * Optional metrics sink. When provided, the adapter records publish /
       * consume / dlq counters, publish/consume durations, and pending-buffer
       * + worker-paused gauges so operators can wire ad-hoc dashboards
       * without log scraping. Defaults to a no-op emitter.
       */
      metrics?: MetricsEmitter;
    },
): SlingshotEventBus & {
  /** {@link HealthCheck.getHealth} — synchronous, last-cached state. */
  getHealth: () => HealthReport;
  /** {@link HealthCheck.checkHealth} — live probe (Redis ping + counts). */
  checkHealth: () => Promise<HealthReport>;
  _drainPendingBuffer: () => Promise<void>;
  /**
   * Structured health snapshot for callers that want the raw counters
   * directly. The `HealthCheck` shape above is preferred for framework
   * aggregation.
   */
  getHealthDetails: () => BullMQAdapterHealth;
  /** Live-probe variant — runs Redis pings + counts. */
  checkHealthDetails: () => Promise<BullMQAdapterHealth>;
  /**
   * Replay jobs from a validation DLQ back to their original source queues.
   * Reads all jobs from the specified DLQ queue, re-enqueues them on the
   * original source queue using the stored event name and original data,
   * and removes them from the DLQ after successful re-enqueue.
   *
   * Returns the number of jobs successfully replayed.
   *
   * @param dlqName - Optional explicit DLQ queue name. When omitted, replays
   *   from all known validation DLQ queues. When provided, name is treated as
   *   the sanitized queue name (colons replaced with underscores).
   */
  replayFromDlq: (dlqName?: string) => Promise<number>;
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
  const logger: Logger = (rawLogger ?? createConsoleLogger()).child({
    component: 'slingshot-bullmq',
  });
  const drainBaseMs = opts.drainBaseMs ?? DEFAULT_DRAIN_BASE_MS;
  const drainMaxMs = opts.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS;
  const maxEnqueueAttempts = opts.maxEnqueueAttempts ?? DEFAULT_MAX_ENQUEUE_ATTEMPTS;
  const validationDlqQueueNameOpt = opts.validationDlqQueueName;
  const walPath = opts.walPath;
  const walCompactThreshold = opts.walCompactThreshold ?? DEFAULT_WAL_COMPACT_THRESHOLD;

  // Counters surfaced via getHealth().
  let validationDroppedCount = 0;
  let bufferDroppedCount = 0;
  let workerPausedCount = 0;
  let enqueueTimeoutCount = 0;
  let permanentErrorCount = 0;
  // Failed-jobs aggregate is null until a live probe has run. `0` could mean
  // either "no failures observed" or "stale snapshot from a freshly-created
  // adapter" — callers should treat null as "unknown".
  let failedJobsCount: number | null = null;
  // Monotonic id allocator for WAL bookkeeping.
  let nextEntryId = 1;

  const wal: PendingBufferWal | null = walPath
    ? new PendingBufferWal(walPath, walCompactThreshold, logger)
    : null;

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

  function notifyDrop(reason: BullMQAdapterDropReason, event: string): void {
    if (!onDrop) return;
    try {
      onDrop(event, reason);
    } catch (err: unknown) {
      logger.error('onDrop callback threw', { err: errInfo(err) });
    }
  }

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

  // In-memory buffer for events that failed to reach Redis (transient blip,
  // failover). When `walPath` is set, every entry is also persisted to a
  // JSON-lines write-ahead log on disk; replaying that file on adapter
  // creation lets buffered events survive a process crash during a Redis
  // outage. Without `walPath` the buffer only bridges downtime within a
  // living process — events sitting in the buffer are lost on crash.
  //
  // Do not "fix" this by making emit() block or return a Promise. That would
  // require changing SlingshotEventBus.emit() from void → Promise<void> and
  // is a breaking change to the interface. Use the WAL or the transactional-
  // outbox pattern at the application layer instead.
  const pendingBuffer: PendingEnqueue[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;
  /** Consecutive drain cycles that left items in the buffer — drives exponential backoff. */
  let drainBackoffCount = 0;
  let isShutdown = false;

  /**
   * Replay any WAL records on adapter creation. The replay runs lazily — the
   * adapter constructor returns immediately, but the first emit/drain blocks
   * until the WAL is loaded if a load is in flight. We track the load promise
   * so durable subscriptions wait on it transparently.
   */
  let walReplayPromise: Promise<void> | null = null;
  if (wal) {
    walReplayPromise = (async () => {
      const records = await wal.load();
      if (records.length === 0) return;
      let highestId = 0;
      for (const rec of records) {
        if (rec.id > highestId) highestId = rec.id;
        // The queue reference for the replayed entry is reattached lazily
        // when a durable subscription is registered (drainPendingBuffer
        // resolves it via durableQueues.get(rec.name)).
        pendingBuffer.push({
          id: rec.id,
          name: rec.name,
          queue: null as unknown as Queue,
          event: rec.event,
          payload: rec.payload,
          attempts: 1,
        });
      }
      if (highestId >= nextEntryId) {
        nextEntryId = highestId + 1;
      }
      logger.info('replayed WAL into pending buffer', {
        entries: records.length,
        nextEntryId,
      });
    })();
    walReplayPromise.catch(err => {
      logger.error('WAL replay failed', { err: errInfo(err) });
    });
  }

  function appendToBuffer(entry: Omit<PendingEnqueue, 'id'>): PendingEnqueue {
    const id = nextEntryId++;
    const full: PendingEnqueue = { id, ...entry };
    pendingBuffer.push(full);
    metrics.gauge('bullmq.pending.size', pendingBuffer.length);
    if (wal) {
      void wal
        .append({
          id,
          name: full.name,
          event: full.event,
          payload: full.payload,
        })
        .catch(err => {
          logger.error('WAL append failed', { err: errInfo(err) });
        });
    }
    return full;
  }

  function consumeFromBuffer(id: number): void {
    if (wal) {
      void wal.consume(id).catch(err => {
        logger.error('WAL consume mark failed', { err: errInfo(err) });
      });
    }
  }

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
    if (drainTimer !== null || isDraining || isShutdown) return;
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
    if (walReplayPromise) await walReplayPromise;
    if (isDraining || pendingBuffer.length === 0) return;
    isDraining = true;
    const retry: PendingEnqueue[] = [];
    for (const item of pendingBuffer) {
      const drainStart = performance.now();
      const queue = item.queue ?? durableQueues.get(item.name);
      if (!queue) {
        // Replayed entries with no live queue yet — keep them buffered until
        // the matching durable subscription is registered.
        retry.push(item);
        continue;
      }
      try {
        await withTimeout(
          queue.add(item.event, item.payload),
          enqueueTimeoutMs,
          `bullmq.add[${item.event}]`,
        );
        const queueName = (queue as { name?: string }).name ?? item.name;
        metrics.counter('bullmq.publish.count', 1, { queue: queueName });
        metrics.timing('bullmq.publish.duration', performance.now() - drainStart, {
          queue: queueName,
        });
        consumeFromBuffer(item.id);
      } catch (err: unknown) {
        const cls = classifyError(err);
        if (cls === 'permanent') {
          permanentErrorCount += 1;
          bufferDroppedCount += 1;
          logger.error('dropping durable event — non-retryable error', {
            event: item.event,
            queue: item.name,
            err: errInfo(err),
          });
          notifyDrop('permanent-error', item.event);
          consumeFromBuffer(item.id);
          continue;
        }
        const next: PendingEnqueue = { ...item, queue, attempts: item.attempts + 1 };
        if (next.attempts >= maxEnqueueAttempts) {
          bufferDroppedCount += 1;
          logger.error('dropping durable event after max attempts', {
            event: item.event,
            queue: item.name,
            attempts: maxEnqueueAttempts,
            err: errInfo(err),
          });
          notifyDrop('max-attempts', item.event);
          consumeFromBuffer(item.id);
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
    if (isShutdown) return;

    const key = event as string;
    if (subscriptionOpts?.durable === true) {
      if (!subscriptionOpts.name) {
        throw new DurableSubscriptionNameRequiredError();
      }

      const subscriptionName = subscriptionOpts.name;
      const mapKey = `${prefix}:${event}:${subscriptionName}`;
      const bullmqQueueName = sanitizeQueueName(mapKey);

      if (durableQueues.has(mapKey)) {
        throw new DuplicateDurableSubscriptionError(event as string, subscriptionName);
      }

      const queue = new Queue(bullmqQueueName, {
        connection: opts.connection,
        defaultJobOptions: { attempts },
      });
      queues.push(queue);
      durableQueues.set(mapKey, queue);

      // Tracks per-job start timestamps so the worker.on('completed' | 'failed')
      // hooks can record consume duration. The processor's `finally` always
      // releases the entry, even on validation-DLQ paths, so the map cannot
      // leak across repeated handler failures.
      const consumeStartByJob = new Map<string, number>();

      const worker = new Worker(
        bullmqQueueName,
        async job => {
          const consumeStart = performance.now();
          if (job.id) consumeStartByJob.set(job.id, consumeStart);
          try {
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
              // Strict-mode validation throws — capture it here so it does
              // not bubble back to BullMQ as a job error (which would
              // consume all configured retries before landing in the failed
              // set). Validation failures are deterministic: the same
              // payload will fail every retry. Route to the validation DLQ
              // instead.
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
                    await withTimeout(
                      dlq.add(`${event as string}:validation-failed`, dlqPayload),
                      enqueueTimeoutMs,
                      `bullmq.dlq[${event as string}]`,
                    );
                    logger.warn('routed strict-validation failure to validation DLQ', {
                      event: event as string,
                      queue: bullmqQueueName,
                      dlq: dlq.name,
                      jobId: job.id,
                      err: errInfo(validationErr),
                    });
                  } catch (dlqErr: unknown) {
                    // DLQ unreachable — log but still complete the job so
                    // it does not retry indefinitely.
                    logger.error('failed to enqueue strict-validation failure to DLQ; dropping', {
                      event: event as string,
                      queue: bullmqQueueName,
                      dlq: dlq.name,
                      jobId: job.id,
                      err: errInfo(dlqErr),
                      validationErr: errInfo(validationErr),
                    });
                  }
                } else {
                  logger.warn('strict-validation failure dropped (no validation DLQ configured)', {
                    event: event as string,
                    queue: bullmqQueueName,
                    jobId: job.id,
                    err: errInfo(validationErr),
                  });
                }
                return; // mark job complete, no retry
              }
              envelope = createRawEventEnvelope(
                event as Extract<keyof SlingshotEventMap, string>,
                validatedPayload as SlingshotEventMap[K],
              );
            }
            await Promise.resolve(listener(envelope as EventEnvelope<K>));
          } finally {
            // Record the consume duration and release the timer-tracking
            // entry. Failure paths that re-throw still need the map cleared,
            // otherwise repeated failures leak per-job entries forever.
            metrics.timing('bullmq.consume.duration', performance.now() - consumeStart, {
              queue: bullmqQueueName,
            });
            if (job.id) consumeStartByJob.delete(job.id);
          }
        },
        { connection: opts.connection },
      );

      worker.on('error', err => {
        workerPausedCount += 1;
        metrics.gauge('bullmq.worker.paused', 1, { queue: bullmqQueueName });
        logger.error('worker error', { queue: bullmqQueueName, err: errInfo(err) });
      });

      worker.on('completed', job => {
        metrics.counter('bullmq.consume.count', 1, {
          queue: bullmqQueueName,
          result: 'success',
        });
        // Defensive cleanup — the processor `finally` already deleted, but
        // covers any path that bypasses the processor.
        if (job?.id) consumeStartByJob.delete(job.id);
      });

      worker.on('failed', (job, err) => {
        metrics.counter('bullmq.consume.count', 1, {
          queue: bullmqQueueName,
          result: 'failure',
        });
        if (job?.id) consumeStartByJob.delete(job.id);
        logger.error('job failed', {
          queue: bullmqQueueName,
          attempt: job?.attemptsMade ?? null,
          maxAttempts: attempts,
          jobId: job?.id ?? null,
          err: errInfo(err),
        });
      });

      workers.push(worker);

      if (!durableListeners.has(key)) durableListeners.set(key, new Set());
      durableListeners.get(key)?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);

      // If WAL replay produced entries waiting on this queue, schedule a
      // drain so they get picked up now that we have a live queue handle.
      if (pendingBuffer.some(item => item.name === mapKey)) {
        scheduleDrain();
      }
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
      throw new DurableSubscriptionOffError();
    }
    envelopeListeners
      .get(key)
      ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  function buildHealthDetails(): BullMQAdapterHealth {
    return {
      status: rollUpBullMQStatus({
        pendingBufferSize: pendingBuffer.length,
        bufferDroppedCount,
        workerPausedCount,
        validationDroppedCount,
        permanentErrorCount,
      }),
      queueCount: queues.length,
      workerCount: workers.length,
      pendingBufferSize: pendingBuffer.length,
      failedJobsCount,
      validationDroppedCount,
      bufferDroppedCount,
      workerPausedCount,
      enqueueTimeoutCount,
      permanentErrorCount,
    };
  }

  function reportHealth(): HealthReport {
    const details = buildHealthDetails();
    const detailRecord: Record<string, unknown> = {
      queueCount: details.queueCount,
      workerCount: details.workerCount,
      pendingBufferSize: details.pendingBufferSize,
      validationDroppedCount: details.validationDroppedCount,
      bufferDroppedCount: details.bufferDroppedCount,
      workerPausedCount: details.workerPausedCount,
      enqueueTimeoutCount: details.enqueueTimeoutCount,
      permanentErrorCount: details.permanentErrorCount,
    };
    detailRecord.failedJobsCount =
      details.failedJobsCount === null ? 'unknown' : details.failedJobsCount;
    const state: HealthState = details.status;
    const message =
      state === 'healthy' ? undefined : `bullmq adapter ${state} (see details for counts)`;
    return {
      component: 'slingshot-bullmq',
      state,
      ...(message ? { message } : {}),
      details: detailRecord,
    };
  }

  return {
    emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
      if (isShutdown) return;

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
            logger.error('listener error', { event: event as string, err: errInfo(err) });
            continue;
          }
          Promise.resolve(result).catch((err: unknown) => {
            logger.error('listener error', { event: event as string, err: errInfo(err) });
          });
        }
      }

      // Enqueue to all durable queues for this event; buffer and retry on
      // Redis failure. Each queue's add is awaited inside an async IIFE so
      // its outcome is observable end-to-end (timeout-aware buffering,
      // structured `enqueueTimeout` log on TimeoutError) without changing
      // the synchronous emit() contract.
      const queuePrefix = `${prefix}:${event}`;
      for (const [name, queue] of durableQueues.entries()) {
        if (!name.startsWith(queuePrefix + ':')) continue;
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
        void (async () => {
          const publishStart = performance.now();
          try {
            await withTimeout(
              queue.add(event as string, durablePayload),
              enqueueTimeoutMs,
              `bullmq.add[${event as string}]`,
            );
            metrics.counter('bullmq.publish.count', 1, { queue: queueName });
            metrics.timing('bullmq.publish.duration', performance.now() - publishStart, {
              queue: queueName,
            });
          } catch (err: unknown) {
            const cls = classifyError(err);
            if (cls === 'permanent') {
              permanentErrorCount += 1;
              bufferDroppedCount += 1;
              logger.error('permanent error on enqueue; dropping durable event', {
                event: event as string,
                queue: name,
                err: errInfo(err),
              });
              notifyDrop('permanent-error', event as string);
              return;
            }
            if (cls === 'timeout') {
              enqueueTimeoutCount += 1;
              metrics.counter('bullmq.enqueue.timeout', 1, { queue: queueName });
              logger.warn('queue.add timed out; buffering for retry', {
                event: event as string,
                queue: name,
                timeoutMs: enqueueTimeoutMs,
              });
              notifyDrop('enqueue-timeout', event as string);
              // Fall through to the buffer-and-retry path below.
            }
            if (pendingBuffer.length >= MAX_PENDING_BUFFER) {
              bufferDroppedCount += 1;
              logger.error('pending buffer full; dropping durable event', {
                event: event as string,
                queue: name,
                err: errInfo(err),
              });
              notifyDrop('buffer-full', event as string);
              return;
            }
            appendToBuffer({
              name,
              queue,
              event: event as string,
              payload: durablePayload,
              attempts: 1,
            });
            scheduleDrain();
          }
        })();
      }
    },

    on<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
      subscriptionOpts?: SubscriptionOpts,
    ): void {
      if (isShutdown) return;

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
        throw new DurableSubscriptionOffError();
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
      isShutdown = true;
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
        logger.warn('shutdown: discarding buffered events', {
          discarded: pendingBuffer.length,
        });
        pendingBuffer.length = 0;
      }
      envelopeListeners.clear();
      payloadListenerWrappers.clear();
      durableListeners.clear();
      await Promise.all(workers.map(w => w.close()));
      await Promise.all(queues.map(q => q.close()));
      if (wal) {
        await wal.flush();
      }
    },

    /** @internal — exposed for testing only; do not use in application code */
    _drainPendingBuffer: drainPendingBuffer,

    getHealth(): HealthReport {
      return reportHealth();
    },

    async checkHealth(): Promise<HealthReport> {
      let total = 0;
      let probeFailed = false;
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
          probeFailed = true;
          logger.warn('getJobCounts failed during health probe', {
            queue: (q as { name?: string }).name ?? null,
            err: errInfo(err),
          });
        }
      }
      // If every queue probe failed, treat the field as unknown rather than
      // pretending the count is zero.
      failedJobsCount = probeFailed && queues.length > 0 && total === 0 ? failedJobsCount : total;
      return reportHealth();
    },

    getHealthDetails(): BullMQAdapterHealth {
      return buildHealthDetails();
    },

    async checkHealthDetails(): Promise<BullMQAdapterHealth> {
      await this.checkHealth();
      return buildHealthDetails();
    },

    async replayFromDlq(dlqName?: string): Promise<number> {
      if (walReplayPromise) await walReplayPromise;
      const targets =
        dlqName !== undefined
          ? (() => {
              const dlq = validationDlqs.get(dlqName);
              return dlq ? new Map([[dlqName, dlq]]) : new Map<string, Queue>();
            })()
          : new Map(validationDlqs);

      let replayed = 0;
      for (const [name, dlq] of targets) {
        // Use the getJobs API to fetch all jobs from the DLQ queue.
        // BullMQ's Queue doesn't expose a typed getJobs on its own,
        // so we access it through the untyped interface.
        const dlqJobs = await (
          dlq as unknown as {
            getJobs: (
              states?: string[],
            ) => Promise<
              Array<{ data: Record<string, unknown>; remove: () => Promise<void>; id?: string }>
            >;
          }
        )
          .getJobs(['waiting', 'delayed', 'prioritized'])
          .catch(() => []);

        for (const job of dlqJobs) {
          const event = job.data?.event as string | undefined;
          const originalData = job.data?.originalData;
          if (!event || originalData === undefined || originalData === null) {
            logger.warn('skipping DLQ job with missing event or originalData', {
              dlq: name,
              jobId: job.id,
            });
            continue;
          }

          // Find the source queue for this event from durable queues
          const sourceQueue = durableQueues.get(
            `slingshot:events:${event}:` + name.split(':').pop(),
          ) as Queue | undefined;
          const finalQueue =
            sourceQueue ??
            (durableQueues.size === 1 ? (durableQueues.values().next().value as Queue) : undefined);

          if (!finalQueue) {
            logger.warn('cannot replay from DLQ — no source queue found for event', {
              dlq: name,
              event,
              jobId: job.id,
            });
            continue;
          }

          try {
            await withTimeout(
              finalQueue.add(event, originalData),
              enqueueTimeoutMs,
              `bullmq.replayDlq[${event}]`,
            );
            metrics.counter('bullmq.dlq.replay.count', 1, { dlq: name });
            await job.remove();
            replayed += 1;
          } catch (err: unknown) {
            logger.error('failed to replay DLQ job', {
              dlq: name,
              event,
              jobId: job.id,
              err: errInfo(err),
            });
          }
        }
      }

      if (replayed > 0) {
        logger.info('replayed jobs from validation DLQ', { replayed });
      }
      return replayed;
    },
  };
}

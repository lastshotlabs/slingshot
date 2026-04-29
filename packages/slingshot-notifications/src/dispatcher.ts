import type {
  DynamicEventBus,
  Logger,
  MetricsEmitter,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  createNoopMetricsEmitter,
  sanitizeLogValue,
} from '@lastshotlabs/slingshot-core';
import { DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS, resolvePreferences } from './preferences';
import type {
  NotificationAdapter,
  NotificationCreatedEventPayload,
  NotificationPreferenceAdapter,
  NotificationPreferenceDefaults,
} from './types';

/** Control surface for the notification dispatcher, providing start/stop lifecycle and per-tick dispatch execution. */
export interface DispatcherAdapter {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<number>;
  /**
   * Point-in-time observability snapshot. Reflects the most recent
   * `listPendingDispatch` / `countPendingDispatch` observation. `pendingCount`
   * is `null` until the first tick has run.
   */
  getHealth(): DispatcherHealth;
}

/**
 * Observability snapshot returned by {@link DispatcherAdapter.getHealth}.
 */
export interface DispatcherHealth {
  /**
   * Total dispatchable rows observed at the most recent tick. `null` until
   * the first tick has executed. When the adapter does not implement
   * `countPendingDispatch`, this reflects only the listed-row count for the
   * tick (capped at `maxPerTick`) and `pendingCountIsLowerBound` is `true`.
   */
  readonly pendingCount: number | null;
  /**
   * `true` when `pendingCount` is the bounded listing-based fallback rather
   * than an exact count. Operators should treat the value as a lower bound.
   */
  readonly pendingCountIsLowerBound: boolean;
  /** Wall-clock ms when the last tick completed. `null` before the first tick. */
  readonly lastTickAt: number | null;
  /** Number of notifications dispatched in the last tick. `null` before the first tick. */
  readonly lastDispatchedCount: number | null;
  /**
   * `true` when the dispatcher logged a saturation warning during the current
   * once-per-minute throttle window. Resets to `false` once the window rolls.
   */
  readonly pendingAlarmActive: boolean;
  /**
   * Number of circuit breakers currently in the open state (tripped and
   * still within cooldown). Updated every tick.
   */
  readonly openBreakerCount: number;
}

/** Configuration for exponential-backoff retries on per-notification publish failures. */
export interface DispatcherRetryOptions {
  /** Max attempts per publish call (initial + retries). Default: 3. */
  readonly maxAttempts?: number;
  /** Base delay between retries in ms. Default: 100. */
  readonly initialDelayMs?: number;
  /** Alias for `initialDelayMs` kept for older test helpers and configs. */
  readonly delayMs?: number;
  /**
   * Upper bound on a single retry-wait, clamped after exponential backoff.
   * Mirrors the push router's `maxDelayMs`. Default: 5 minutes.
   */
  readonly maxDelayMs?: number;
}

/** Configuration for the per-destination circuit breaker that short-circuits delivery after consecutive failures. */
export interface DispatcherBreakerOptions {
  /**
   * Consecutive failures-per-destination before further sends to that
   * destination are short-circuited within a tick. Default: 5.
   */
  readonly threshold?: number;
  /** Alias for `threshold` kept for older test helpers and configs. */
  readonly failureThreshold?: number;
  /**
   * Cooldown duration after the breaker trips, in ms. Subsequent ticks within
   * the cooldown skip the destination entirely. Default: 5 minutes.
   */
  readonly cooldownMs?: number;
  /** Alias for `cooldownMs` kept for older test helpers and configs. */
  readonly resetTimeoutMs?: number;
}

/**
 * Payload delivered to the {@link CreateIntervalDispatcherOptions.onDeadLetter}
 * callback when a notification exhausts all retry attempts within a tick.
 */
export interface DeadLetterEvent {
  /** The notification record that could not be published. */
  readonly notification: { id: string; userId: string };
  /** The last error thrown by the publish call. */
  readonly error: Error;
  /** Total publish attempts made (initial attempt + retries). */
  readonly attempts: number;
}

/** Options for {@link createIntervalDispatcher}, including adapters, bus, polling intervals, retry/breaker tuning, and observability hooks. */
export interface CreateIntervalDispatcherOptions {
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly bus: SlingshotEventBus;
  readonly events: SlingshotEvents;
  readonly defaultPreferences?: NotificationPreferenceDefaults;
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
  /** Alias for `maxPerTick` kept for older test helpers and configs. */
  readonly batchSize?: number;
  /** Maximum ms to wait for an in-flight tick to complete on stop(). Default: 10000. */
  readonly stopTimeoutMs?: number;
  /** Per-publish retry/backoff configuration. */
  readonly retry?: DispatcherRetryOptions;
  /** Per-destination consecutive-failure circuit breaker configuration. */
  readonly breaker?: DispatcherBreakerOptions;
  /**
   * Pending-row count above which the dispatcher logs a structured
   * saturation warning. `0` disables the alarm. Default: 50 000. The warning
   * fires at most once per minute regardless of how many ticks observe
   * saturation.
   *
   * Notification rows are durable in the underlying store, so this is a
   * back-pressure signal rather than a memory cap — it lets operators detect
   * when publish rate persistently exceeds the per-tick processing budget.
   */
  readonly maxPendingBeforeAlarm?: number;
  /**
   * Throttle window for the saturation warning, in ms. Default: 60 000
   * (one minute). The warning is logged at most once per window even when
   * saturation persists across many ticks.
   */
  readonly pendingAlarmThrottleMs?: number;
  /** Optional clock injection for tests. */
  readonly now?: () => number;
  /**
   * Optional unified metrics emitter. Defaults to a no-op. When provided, the
   * dispatcher records:
   * - `notifications.dispatch.count` counter (labels: `result=success|failure`)
   * - `notifications.dispatch.duration` timing per tick (no labels)
   * - `notifications.pending.size` gauge per tick (no labels)
   * - `notifications.retry.count` counter on every publish retry (labels: `attempt=<N>`)
   * - `notifications.circuitBreaker.openCount` gauge per tick (no labels — aggregate to keep cardinality bounded)
   */
  readonly metrics?: MetricsEmitter;
  /** Optional structured logger. Defaults to a console-backed JSON logger. */
  readonly logger?: Logger;
  /**
   * Optional callback invoked when a notification exhausts all retry attempts
   * in a single tick *without* an open circuit breaker (retry budget
   * exhausted, not short-circuited). This is the dead-letter signal: the
   * dispatcher has given up on this notification for this tick. Apps can
   * use this to move the notification to a dead-letter queue, increment an
   * alert counter, or trigger alternative delivery. The callback is fire-
   * and-forget (errors are logged but never propagated).
   *
   * When the circuit breaker is open for a destination, rows are silently
   * skipped and do not invoke this callback — they will be retried on a
   * future tick once the cooldown elapses.
   *
   * @example
   * ```ts
   * onDeadLetter: async ({ notification, error, attempts }) => {
   *   await deadLetterQueue.enqueue(notification.id);
   * }
   * ```
   */
  readonly onDeadLetter?: (event: DeadLetterEvent) => void | Promise<void>;
}

interface BreakerState {
  /** Consecutive failures across attempts (excluding successful resets). */
  consecutiveFailures: number;
  /** Wall-clock ms when the breaker becomes eligible to retry again. */
  openUntil: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create the default polling dispatcher for scheduled notifications.
 *
 * @param options - Dispatcher dependencies.
 * @returns Polling dispatcher.
 *
 * @remarks
 * The dispatcher publishes scheduled notifications to the event bus. When a
 * publish call throws (provider failure), the dispatcher retries with
 * exponential backoff up to `retry.maxAttempts`, clamping each delay to
 * `retry.maxDelayMs` (mirrors the push router's clamp). Consecutive failures
 * to the same destination (`row.userId`) trip a circuit breaker — once
 * `breaker.threshold` consecutive failures accumulate, further sends to that
 * destination are short-circuited (the row is rolled back to undispatched and
 * skipped) until `breaker.cooldownMs` elapses. A successful publish resets
 * the breaker for that destination.
 */
export function createIntervalDispatcher(
  options: CreateIntervalDispatcherOptions,
): DispatcherAdapter {
  const intervalMs = options.intervalMs ?? 30_000;
  const maxPerTick = options.maxPerTick ?? options.batchSize ?? 500;
  const defaultPreferences = options.defaultPreferences ?? DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
  const initialDelayMs = Math.max(
    0,
    options.retry?.initialDelayMs ?? options.retry?.delayMs ?? 100,
  );
  const maxDelayMs = Math.max(0, options.retry?.maxDelayMs ?? 5 * 60_000);
  const breakerThreshold = Math.max(
    1,
    options.breaker?.threshold ?? options.breaker?.failureThreshold ?? 5,
  );
  const breakerCooldownMs = Math.max(
    0,
    options.breaker?.cooldownMs ?? options.breaker?.resetTimeoutMs ?? 5 * 60_000,
  );
  const maxPendingBeforeAlarm = Math.max(0, options.maxPendingBeforeAlarm ?? 50_000);
  const pendingAlarmThrottleMs = Math.max(0, options.pendingAlarmThrottleMs ?? 60_000);
  const now = options.now ?? (() => Date.now());
  const metrics: MetricsEmitter = options.metrics ?? createNoopMetricsEmitter();
  const logger: Logger =
    options.logger ?? createConsoleLogger({ base: { plugin: 'slingshot-notifications' } });
  const dynamicBus = options.bus as unknown as DynamicEventBus;
  const onDeadLetter = options.onDeadLetter;

  // Most-recent observability state. Populated at the start of every tick.
  let lastPendingCount: number | null = null;
  let lastPendingCountIsLowerBound = false;
  let lastTickAt: number | null = null;
  let lastDispatchedCount: number | null = null;
  // Wall-clock ms of the last logged saturation warning. Used to throttle the
  // structured warning to at most once per `pendingAlarmThrottleMs` window.
  let lastPendingAlarmAt = 0;

  function maybeWarnPendingSaturation(observed: number, isExact: boolean): void {
    if (maxPendingBeforeAlarm <= 0) return;
    if (observed < maxPendingBeforeAlarm) return;
    const ts = now();
    if (ts - lastPendingAlarmAt < pendingAlarmThrottleMs) return;
    lastPendingAlarmAt = ts;
    console.warn(
      '[slingshot-notifications] Dispatcher pending saturation: ' +
        `observed ${observed}${isExact ? '' : '+ (lower bound)'} pending notifications, ` +
        `threshold ${maxPendingBeforeAlarm}. ` +
        'Publish rate may be exceeding per-tick processing budget. ' +
        'Consider increasing maxPerTick, decreasing intervalMs, or scaling out the dispatcher.',
    );
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let inflightTick: Promise<void> | null = null;
  let activeTickAbortController: AbortController | null = null;
  // Set to true on stop() so a tick that was already mid-flight when stop()
  // was called bails out at every async hop and stops issuing further
  // provider work. The AbortController inside the tick handles cancellation
  // of pending provider awaits, but `stopped` is the source of truth that
  // also prevents the tick from publishing post-stop or rolling back state
  // after the dispatcher has been declared shut down.
  let stopped = false;

  // Per-destination breaker state. Persists across ticks so cooldowns survive
  // tick boundaries; trimmed on success.
  const breakerByDestination = new Map<string, BreakerState>();

  function getBreaker(dest: string): BreakerState {
    let state = breakerByDestination.get(dest);
    if (!state) {
      state = { consecutiveFailures: 0, openUntil: 0 };
      breakerByDestination.set(dest, state);
    }
    return state;
  }

  function recordSuccess(dest: string): void {
    const existing = breakerByDestination.get(dest);
    if (existing) breakerByDestination.delete(dest);
  }

  function recordFailure(dest: string): BreakerState {
    const state = getBreaker(dest);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= breakerThreshold) {
      state.openUntil = now() + breakerCooldownMs;
    }
    return state;
  }

  function isBreakerOpen(dest: string): boolean {
    const state = breakerByDestination.get(dest);
    if (!state) return false;
    if (state.openUntil === 0) return false;
    if (now() >= state.openUntil) {
      // Cooldown elapsed — half-open: clear the cooldown but leave the
      // failure count so a single new failure trips it again. The next
      // attempt is the probe.
      state.openUntil = 0;
      return false;
    }
    return true;
  }

  async function runTick(): Promise<void> {
    // If the dispatcher has been stopped between scheduling and dispatch (the
    // setInterval callback was already on the macrotask queue when stop()
    // ran), the tick must not proceed. This is the first of several
    // `stopped` re-checks — see `tick()` below for the per-async-hop checks
    // that protect a tick already in progress.
    if (stopped) return;
    if (inflightTick) return;
    let resolve!: () => void;
    inflightTick = new Promise<void>(r => {
      resolve = r;
    });
    try {
      await dispatcher.tick();
    } catch (err) {
      console.error('[slingshot-notifications] Dispatcher tick failed', err);
    } finally {
      inflightTick = null;
      resolve();
    }
  }

  const dispatcher: DispatcherAdapter = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runTick();
      }, intervalMs);
    },
    async stop() {
      // Mark the dispatcher as stopped FIRST so any in-flight tick can detect
      // it on its next async hop and bail before publishing further events
      // or rolling back additional rows. This must happen before
      // `clearInterval` so a tick scheduled-but-not-yet-dispatched also
      // returns from `runTick()`'s top-level `stopped` guard.
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Abort any sleeps the in-flight tick is currently waiting on so the
      // tick promise settles promptly rather than waiting out the full retry
      // backoff.
      activeTickAbortController?.abort(new Error('dispatcher stopped'));
      if (!inflightTick) return;
      const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inflightTick,
          new Promise<void>((_, reject) => {
            timeout = setTimeout(() => {
              activeTickAbortController?.abort(
                new Error(`stop() timed out after ${stopTimeoutMs}ms`),
              );
              reject(new Error(`stop() timed out after ${stopTimeoutMs}ms`));
            }, stopTimeoutMs);
          }),
        ]);
      } catch (err) {
        console.error(
          '[slingshot-notifications] Dispatcher stop(): inflight tick did not settle',
          err,
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    async tick() {
      const dispatchedAt = new Date();
      const abortController = new AbortController();
      activeTickAbortController = abortController;
      const tickStart = performance.now();
      try {
        // `stopped` short-circuit before the first async hop. When stop() runs
        // between schedule and dispatch this guard prevents a wasted DB query.
        if (stopped) return 0;
        const rows = await options.notifications.listPendingDispatch({
          limit: maxPerTick,
          now: dispatchedAt,
          signal: abortController.signal,
        });
        // Re-check after the await — stop() may have flipped `stopped` while
        // listPendingDispatch was in flight. We must not iterate the rows or
        // touch any provider state once the dispatcher is shut down.
        if (stopped) return 0;

        // Observability: capture pending count for the health snapshot and
        // emit a once-per-minute warning when it crosses the alarm
        // threshold. Adapters that implement `countPendingDispatch` provide
        // an exact total; otherwise we fall back to the listed-row count
        // capped at `maxPerTick`, which is a lower bound.
        if (typeof options.notifications.countPendingDispatch === 'function') {
          try {
            const exact = await options.notifications.countPendingDispatch({
              now: dispatchedAt,
              signal: abortController.signal,
            });
            lastPendingCount = exact;
            lastPendingCountIsLowerBound = false;
            maybeWarnPendingSaturation(exact, true);
          } catch (err) {
            // Counting is best-effort — never let it break dispatch.
            console.error(
              '[slingshot-notifications] Dispatcher countPendingDispatch failed (continuing)',
              err,
            );
            lastPendingCount = rows.length;
            lastPendingCountIsLowerBound = rows.length >= maxPerTick;
            if (rows.length >= maxPerTick) {
              maybeWarnPendingSaturation(rows.length, false);
            }
          }
        } else {
          lastPendingCount = rows.length;
          lastPendingCountIsLowerBound = rows.length >= maxPerTick;
          if (rows.length >= maxPerTick) {
            maybeWarnPendingSaturation(rows.length, false);
          }
        }
        // Publish the pending-size gauge once per tick now that we have the
        // most up-to-date observation (exact when available, lower-bound
        // otherwise). Cardinality discipline: no labels — aggregating across
        // notification types or destinations would explode the series count.
        if (lastPendingCount !== null) {
          metrics.gauge('notifications.pending.size', lastPendingCount);
        }
        if (stopped) return 0;

        let dispatchedCount = 0;

        for (const row of rows.slice(0, maxPerTick)) {
          if (abortController.signal.aborted || stopped) break;

          // Per-destination short-circuit. The breaker is keyed on userId so a
          // single misbehaving downstream cannot starve unrelated users.
          const destination = row.userId;
          if (isBreakerOpen(destination)) {
            // Don't retry this row in this tick — leave it pending so a
            // later tick (after cooldown) picks it up again.
            continue;
          }

          let preferences;
          try {
            preferences = await resolvePreferences(
              options.preferences,
              row.userId,
              row.source,
              row.type,
              defaultPreferences,
            );
          } catch (err) {
            // P-NOTIF-10: a throwing preference adapter is operationally
            // distinct from a missing preference (defaults). Escalate via
            // structured logger and emit `notify:dispatcher.preferenceError`
            // so apps can alert; skip the row and re-queue for the next tick
            // by rolling back the dispatched flag.
            const e = err instanceof Error ? err : new Error(String(err));
            logger.warn('dispatcher preference resolution failed', {
              userId: row.userId,
              source: row.source,
              type: row.type,
              err: e.message,
            });
            metrics.counter('notifications.preferences.error', 1);
            try {
              dynamicBus.emit('notify:dispatcher.preferenceError', {
                notificationId: row.id,
                userId: row.userId,
                source: row.source,
                type: row.type,
                error: { message: e.message, name: e.name },
              });
            } catch {
              // bus emission must never break the dispatch loop
            }
            // Do NOT mark dispatched — leave it pending for the next tick.
            continue;
          }
          if (abortController.signal.aborted || stopped) break;
          const payload: NotificationCreatedEventPayload = {
            notification: row,
            preferences,
          };

          await options.notifications.markDispatched({ id: row.id, dispatchedAt });
          // After persisting the dispatched flag we are committed to either
          // publishing or rolling back, but if stop() was called during the
          // markDispatched await we need to roll back this row and exit the
          // loop — publishing post-stop would deliver work the caller has
          // declared shut down.
          if (stopped) {
            try {
              await options.notifications.update(row.id, {
                dispatched: false,
                dispatchedAt: null,
              });
            } catch (rollbackErr) {
              // row.id is generated server-side but originates ultimately
              // from a notification create call; sanitize so a hostile
              // identifier cannot split the log line.
              console.error(
                `[slingshot-notifications] Failed to roll back '${sanitizeLogValue(row.id)}' after stop()`,
                rollbackErr,
              );
            }
            break;
          }
          let published = false;
          let lastErr: unknown;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (abortController.signal.aborted || stopped) break;
            // Count every attempt past the first as a retry, labeled by
            // attempt number so operators can see whether retries are
            // succeeding on the second/third try or running out the budget.
            if (attempt > 1) {
              metrics.counter('notifications.retry.count', 1, { attempt: String(attempt) });
            }
            try {
              options.events.publish('notifications:notification.created', payload, {
                userId: row.userId,
                actorId: row.actorId ?? row.userId,
                source: 'system',
                // Background dispatcher — no originating HTTP request.
                requestTenantId: null,
              });
              published = true;
              recordSuccess(destination);
              dispatchedCount += 1;
              metrics.counter('notifications.dispatch.count', 1, { result: 'success' });
              break;
            } catch (err) {
              lastErr = err;
              recordFailure(destination);
              if (attempt >= maxAttempts) break;
              if (isBreakerOpen(destination)) break;
              const exponential = initialDelayMs * Math.pow(2, attempt - 1);
              const delay = Math.min(maxDelayMs, exponential);
              try {
                await sleep(delay, abortController.signal);
              } catch {
                // aborted while sleeping — fall through to rollback
                break;
              }
              if (stopped) break;
            }
          }

          if (!published) {
            metrics.counter('notifications.dispatch.count', 1, { result: 'failure' });
          }

          if (!published) {
            const safeRowId = sanitizeLogValue(row.id);
            try {
              await options.notifications.update(row.id, {
                dispatched: false,
                dispatchedAt: null,
              });
            } catch (rollbackErr) {
              console.error(
                `[slingshot-notifications] Failed to roll back dispatched state for notification '${safeRowId}'`,
                rollbackErr,
              );
            }
            console.error(
              `[slingshot-notifications] Failed to publish notification '${safeRowId}' after marking it dispatched`,
              lastErr,
            );
            // Fire the dead-letter callback so apps can alert or re-queue.
            if (onDeadLetter && lastErr instanceof Error) {
              try {
                const result = onDeadLetter({
                  notification: { id: row.id, userId: row.userId },
                  error: lastErr,
                  attempts: maxAttempts,
                });
                if (result instanceof Promise) {
                  result.catch((dlErr: unknown) => {
                    logger.warn('onDeadLetter callback rejected', {
                      notificationId: row.id,
                      err: dlErr instanceof Error ? dlErr.message : String(dlErr),
                    });
                  });
                }
              } catch (dlErr) {
                logger.warn('onDeadLetter callback threw', {
                  notificationId: row.id,
                  err: dlErr instanceof Error ? dlErr.message : String(dlErr),
                });
              }
            }
          }
          if (stopped) break;
        }

        lastDispatchedCount = dispatchedCount;
        lastTickAt = now();
        // Aggregate breaker-open count to keep cardinality bounded. Per-
        // destination labels would put a userId into a metric label, which the
        // emitter contract explicitly warns against.
        let openBreakers = 0;
        const ts = now();
        for (const state of breakerByDestination.values()) {
          if (state.openUntil !== 0 && ts < state.openUntil) openBreakers += 1;
        }
        metrics.gauge('notifications.circuitBreaker.openCount', openBreakers);
        return dispatchedCount;
      } finally {
        metrics.timing('notifications.dispatch.duration', performance.now() - tickStart);
        if (activeTickAbortController === abortController) {
          activeTickAbortController = null;
        }
      }
    },
    getHealth(): DispatcherHealth {
      const ts = now();
      const alarmActive =
        lastPendingAlarmAt !== 0 && ts - lastPendingAlarmAt < pendingAlarmThrottleMs;
      // Count open breakers at health-read time so the snapshot is fresh.
      let openBreakerCount = 0;
      for (const state of breakerByDestination.values()) {
        if (state.openUntil !== 0 && ts < state.openUntil) openBreakerCount += 1;
      }
      return {
        pendingCount: lastPendingCount,
        pendingCountIsLowerBound: lastPendingCountIsLowerBound,
        lastTickAt,
        lastDispatchedCount,
        pendingAlarmActive: alarmActive,
        openBreakerCount,
      };
    },
  };

  return dispatcher;
}

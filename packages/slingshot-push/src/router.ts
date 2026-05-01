import type { MetricsEmitter } from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  createNoopMetricsEmitter,
  sanitizeLogValue,
} from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { PushRouterError } from './errors';
import { buildProviderIdempotencyKey } from './lib/idempotency';
import type { PushProvider } from './providers/provider';
import type {
  PushMessage,
  PushPlatform,
  PushProviderSendContext,
  PushSendResult,
  PushSubscriptionRecord,
  PushTopicMembershipRecord,
} from './types/models';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-push' } });

function errorLogFields(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

type RouterSubscriptionRecord = {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly platformData: unknown;
  readonly createdAt: Date | string;
  readonly lastSeenAt: Date | string;
};

type RouterDeliveryRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly platform: string;
  readonly notificationId?: string | null;
  readonly providerMessageId?: string | null;
  readonly status: string;
  readonly failureReason?: string | null;
  readonly attempts: number;
  readonly sentAt?: Date | string | null;
  readonly deliveredAt?: Date | string | null;
  readonly createdAt: Date | string;
};

type DynamicBus = {
  emit(event: string, payload: unknown): void;
};

/**
 * Cancellable sleep used by router retry backoff. When `signal` is provided
 * and aborted, the sleep rejects immediately with an `'aborted'` error so the
 * outer retry loop can unwind and stop spawning further attempts. Without
 * cancellation, in-flight sleeps would tick through `stop()` and continue
 * touching repositories long after teardown began. P-PUSH-6.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    let onAbort: (() => void) | null = null;
    if (signal) {
      const handleAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', handleAbort);
        reject(new Error('aborted'));
      };
      onAbort = handleAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function sendWithProviderTimeout(
  provider: PushProvider,
  subscription: PushSubscriptionRecord,
  message: PushMessage,
  timeoutMs: number,
  context: PushProviderSendContext,
): Promise<PushSendResult> {
  if (timeoutMs <= 0) return provider.send(subscription, message, context);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.send(subscription, message, { ...context, signal: ac.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error(`push provider timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PushSubscriptionRepo {
  create(input: Record<string, unknown>): Promise<RouterSubscriptionRecord>;
  getById(id: string): Promise<RouterSubscriptionRecord | null>;
  delete(id: string): Promise<boolean>;
  listByUserId(params: {
    userId: string;
    tenantId: string;
  }): Promise<{ items: RouterSubscriptionRecord[] } | RouterSubscriptionRecord[]>;
  findByDevice(params: {
    userId: string;
    tenantId: string;
    deviceId: string;
  }): Promise<RouterSubscriptionRecord | null>;
  touchLastSeen(
    params: { id: string },
    input: { lastSeenAt?: Date | string },
  ): Promise<RouterSubscriptionRecord>;
  upsertByDevice(params: Record<string, unknown>): Promise<RouterSubscriptionRecord>;
}

interface PushTopicRepo {
  ensureByName(params: {
    tenantId: string;
    name: string;
  }): Promise<{ id: string; name: string; tenantId: string }>;
  findByName(params: {
    tenantId: string;
    name: string;
  }): Promise<{ id: string; name: string; tenantId: string } | null>;
}

interface PushTopicMembershipRepo {
  ensureMembership(params: {
    topicId: string;
    subscriptionId: string;
    userId: string;
    tenantId: string;
  }): Promise<PushTopicMembershipRecord>;
  listByTopic(params: {
    topicId: string;
  }): Promise<{ items: PushTopicMembershipRecord[] } | PushTopicMembershipRecord[]>;
  removeByTopicAndSub(params: {
    topicId: string;
    subscriptionId: string;
  }): Promise<number | { count: number }>;
  removeBySubscription(params: { subscriptionId: string }): Promise<number | { count: number }>;
}

interface PushDeliveryRepo {
  create(input: Record<string, unknown>): Promise<RouterDeliveryRecord>;
  getById(id: string): Promise<RouterDeliveryRecord | null>;
  markSent(params: {
    id: string;
    providerMessageId?: string;
    providerIdempotencyKey?: string;
  }): Promise<RouterDeliveryRecord | null>;
  markDelivered(params: { id: string; 'actor.id': string }): Promise<RouterDeliveryRecord | null>;
  markFailed(params: { id: string; failureReason: string }): Promise<RouterDeliveryRecord | null>;
  incrementAttempts(id: string, by?: number): Promise<Record<string, unknown>>;
}

/** Repository bundle required by the push router. */
export interface PushRouterRepos {
  readonly subscriptions: PushSubscriptionRepo;
  readonly topics: PushTopicRepo;
  readonly topicMemberships: PushTopicMembershipRepo;
  readonly deliveries: PushDeliveryRepo;
}

/**
 * Result of a router fan-out call.
 *
 * The router does not throw when every provider fails — see README "All-providers-fail
 * contract". Callers can detect total failure via `allFailed` without inspecting the bus.
 *
 * - `delivered` — number of subscriptions successfully sent (provider returned `ok: true`).
 * - `attempted` — number of subscriptions for which delivery was attempted (i.e. had a
 *   matching provider configured for the platform). Subscriptions skipped because no
 *   provider is wired for their platform are not counted.
 * - `allFailed` — `true` iff `attempted > 0 && delivered === 0`. `false` when at least one
 *   subscription was delivered or when no subscription was even attempted.
 */
export interface PushSendResultSummary {
  readonly delivered: number;
  readonly attempted: number;
  readonly allFailed: boolean;
}

/** Router API used for user fan-out and topic publishes. */
export interface PushRouter {
  sendToUser(
    userId: string,
    message: PushMessage,
    opts?: {
      tenantId?: string;
      notificationId?: string;
      /**
       * Per-call override for the provider send timeout. When omitted, the
       * router uses `providerTimeoutMs` from `createPushRouter`. Plumbed by
       * the notifications delivery adapter (P-PUSH-12).
       */
      providerTimeoutMs?: number;
    },
  ): Promise<PushSendResultSummary>;
  sendToUsers(
    userIds: readonly string[],
    message: PushMessage,
    opts?: {
      tenantId?: string;
      notificationId?: string;
      providerTimeoutMs?: number;
    },
  ): Promise<PushSendResultSummary>;
  publishTopic(
    topicName: string,
    message: PushMessage,
    opts?: {
      tenantId?: string;
      notificationId?: string;
      providerTimeoutMs?: number;
    },
  ): Promise<PushSendResultSummary>;
  /**
   * Abort all in-flight retry sleeps so a graceful shutdown unwinds promptly
   * instead of running attempts past teardown. P-PUSH-6.
   */
  stop(): void;

  /**
   * Snapshot of the router-level circuit breaker state. Returns null when the
   * breaker is disabled (threshold === 0).
   */
  getBreakerHealth?(): {
    readonly circuitState: 'closed' | 'open' | 'half-open';
    readonly consecutiveFailures: number;
  } | null;
}

function asItems<T>(result: { items: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.items;
}

function toPushPlatform(value: string): PushPlatform | null {
  return value === 'web' || value === 'ios' || value === 'android' ? value : null;
}

function toProviderSubscription(
  subscription: RouterSubscriptionRecord,
  platform: PushPlatform,
): PushSubscriptionRecord {
  return {
    ...subscription,
    platform,
    platformData: subscription.platformData as PushSubscriptionRecord['platformData'],
  };
}

/**
 * Create the push router used for user and topic fan-out.
 *
 * @param options - Provider, repository, retry, and event-bus dependencies.
 * @returns A router that persists deliveries and dispatches them by
 *   subscription platform.
 */
export function createPushRouter(options: {
  providers: Readonly<Partial<Record<PushPlatform, PushProvider>>>;
  repos: PushRouterRepos;
  retries?: { maxAttempts?: number; initialDelayMs?: number; maxDelayMs?: number };
  bus?: DynamicBus;
  /** Maximum milliseconds for a single provider.send() call before it is treated as transient failure. Default: 30000. */
  providerTimeoutMs?: number;
  /** Subscriptions per topic-fan-out batch. Default: 1000. */
  topicFanoutBatchSize?: number;
  /** Max concurrent in-flight batches before back-pressure kicks in. Default: 10. */
  topicFanoutMaxPending?: number;
  /**
   * Optional metrics sink. When provided, the router records per-send
   * counters/timings, topic fan-out counters, subscription-cleanup counters,
   * and per-provider circuit-breaker / consecutive-failure gauges so
   * operators can wire ad-hoc dashboards without parsing logs. Defaults to
   * a no-op emitter.
   */
  metrics?: MetricsEmitter;
  /**
   * Maximum subscriptions that may receive a single topic publish before the
   * router emits `push:topic.fanout.truncated`, returns a partial result, and
   * stops scheduling further batches. Default: 10000. P-PUSH-11.
   */
  topicMaxRecipients?: number;
  /**
   * Router-level circuit breaker threshold — consecutive total-fan-out
   * failures (every subscription in a sendToUser/sendToUsers/publishTopic
   * returned allFailed) before the breaker opens and short-circuits
   * subsequent sends. Default: 10. Set to 0 to disable the router-level
   * breaker.
   */
  routerCircuitBreakerThreshold?: number;
  /**
   * Router-level circuit breaker cooldown in ms before admitting a
   * half-open probe after the breaker opens. Default: 30000.
   */
  routerCircuitBreakerCooldownMs?: number;
}): PushRouter {
  const maxAttempts = options.retries?.maxAttempts ?? 3;
  const initialDelayMs = options.retries?.initialDelayMs ?? 1_000;
  // Upper bound on a single retry-wait, to clamp absurd `Retry-After` hints
  // (e.g. a server returning hours) and prevent worker starvation.
  const maxRetryDelayMs = options.retries?.maxDelayMs ?? 5 * 60_000;
  const defaultProviderTimeoutMs = options.providerTimeoutMs ?? 30_000;
  const topicFanoutBatchSize = Math.max(1, options.topicFanoutBatchSize ?? 1000);
  const topicFanoutMaxPending = Math.max(1, options.topicFanoutMaxPending ?? 10);
  const topicMaxRecipients = Math.max(1, options.topicMaxRecipients ?? 10_000);
  const metrics: MetricsEmitter = options.metrics ?? createNoopMetricsEmitter();
  // Lifecycle abort signal used to unwind in-flight retry sleeps on stop().
  const lifecycleController = new AbortController();
  const lifecycleSignal = lifecycleController.signal;

  // --- Router-level circuit breaker ---
  // Tracks consecutive fan-out-level failures across ALL providers. When
  // every subscription in a sendToUser/sendToUsers/publishTopic returns
  // allFailed, the router-level counter increments. When it reaches
  // `routerCircuitBreakerThreshold`, the breaker opens and short-circuits
  // all subsequent sends until the cooldown elapses.
  const routerBreakerThreshold = Math.max(0, options.routerCircuitBreakerThreshold ?? 10);
  const routerBreakerCooldownMs = Math.max(0, options.routerCircuitBreakerCooldownMs ?? 30_000);
  let routerBreakerState: 'closed' | 'open' | 'half-open' = 'closed';
  let routerBreakerFailures = 0;
  let routerBreakerOpenedAt: number | undefined;

  function isRouterBreakerAllowed(now: number): boolean {
    if (routerBreakerThreshold === 0) return true; // disabled
    if (routerBreakerState === 'closed') return true;
    if (routerBreakerState === 'half-open') return true; // probe already in flight
    // state === 'open'
    if (routerBreakerOpenedAt === undefined) return true;
    if (now - routerBreakerOpenedAt >= routerBreakerCooldownMs) {
      routerBreakerState = 'half-open';
      return true;
    }
    return false;
  }

  function recordRouterSuccess(): void {
    if (routerBreakerFailures === 0) return;
    routerBreakerFailures = 0;
    routerBreakerState = 'closed';
    routerBreakerOpenedAt = undefined;
  }

  function recordRouterFailure(): void {
    if (routerBreakerThreshold === 0) return;
    routerBreakerFailures += 1;
    if (routerBreakerState === 'half-open') {
      // Half-open probe failed — return to open.
      routerBreakerState = 'open';
      routerBreakerOpenedAt = Date.now();
      return;
    }
    if (routerBreakerFailures >= routerBreakerThreshold && routerBreakerState === 'closed') {
      routerBreakerState = 'open';
      routerBreakerOpenedAt = Date.now();
    }
  }

  function guardRouterSend<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (!isRouterBreakerAllowed(now)) {
      const retryAfterMs =
        routerBreakerOpenedAt !== undefined
          ? Math.max(0, routerBreakerOpenedAt + routerBreakerCooldownMs - now)
          : routerBreakerCooldownMs;
      return Promise.reject(
        new PushRouterError(
          `[slingshot-push] Router circuit breaker open after ${routerBreakerFailures} ` +
            `consecutive fan-out failures. Retrying in ~${retryAfterMs}ms.`,
        ),
      );
    }
    return fn();
  }

  const CIRCUIT_STATE_VALUES: Record<'closed' | 'open' | 'half-open', number> = {
    closed: 0,
    open: 1,
    'half-open': 2,
  };

  function sampleProviderHealth(platform: PushPlatform): void {
    const provider = options.providers[platform];
    if (!provider?.getHealth) return;
    const health = provider.getHealth();
    metrics.gauge('push.circuitBreaker.state', CIRCUIT_STATE_VALUES[health.circuitState] ?? 0, {
      provider: platform,
    });
    metrics.gauge('push.consecutiveFailures', health.consecutiveFailures, {
      provider: platform,
    });
  }

  async function sendToSubscriptions(
    subscriptions: readonly RouterSubscriptionRecord[],
    message: PushMessage,
    opts: { tenantId: string; notificationId?: string; providerTimeoutMs?: number },
  ): Promise<{ delivered: number; attempted: number }> {
    const effectiveTimeoutMs = opts.providerTimeoutMs ?? defaultProviderTimeoutMs;
    let deliveredCount = 0;
    let attemptedCount = 0;

    for (const subscription of subscriptions) {
      const platform = toPushPlatform(subscription.platform);
      if (!platform) continue;

      const provider = options.providers[platform];
      if (!provider) continue;

      attemptedCount += 1;

      let delivery: RouterDeliveryRecord;
      try {
        delivery = await options.repos.deliveries.create({
          tenantId: opts.tenantId,
          userId: subscription.userId,
          subscriptionId: subscription.id,
          platform,
          notificationId: opts.notificationId,
        });
      } catch (err) {
        // subscription.id is server-generated but originates ultimately
        // from a registration request; sanitize before interpolating.
        logger.error(
          `[slingshot-push] Failed to create delivery for subscription="${sanitizeLogValue(subscription.id)}"`,
          errorLogFields(err),
        );
        options.bus?.emit('push:delivery.failed', {
          subscriptionId: subscription.id,
          userId: subscription.userId,
          reason: 'deliveryCreateFailed',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const payload: PushMessage = {
        ...message,
        data: {
          ...(message.data ?? {}),
          __slingshotDeliveryId: delivery.id,
        },
      };

      let attempts = 0;
      let sent = false;

      try {
        while (attempts < maxAttempts) {
          attempts += 1;
          await options.repos.deliveries.incrementAttempts(delivery.id, 1);

          const idempotencyKey = buildProviderIdempotencyKey(delivery.id, attempts);
          let result;
          const sendStart = performance.now();
          try {
            result = await sendWithProviderTimeout(
              provider,
              toProviderSubscription(subscription, platform),
              payload,
              effectiveTimeoutMs,
              { idempotencyKey },
            );
          } catch (err) {
            logger.error(
              `[slingshot-push] Provider threw or timed out for platform="${sanitizeLogValue(platform)}" userId="${sanitizeLogValue(subscription.userId)}"`,
              errorLogFields(err),
            );
            result = {
              ok: false,
              reason: 'transient' as const,
              error: err instanceof Error ? err.message : 'push provider threw or timed out',
            };
          }
          metrics.timing('push.send.duration', performance.now() - sendStart, {
            provider: platform,
          });
          metrics.counter('push.send.count', 1, {
            provider: platform,
            result: result.ok ? 'success' : (result.reason ?? 'transient'),
          });
          // After each attempt, refresh circuit-breaker / failure gauges so
          // dashboards reflect provider health without polling getHealth().
          sampleProviderHealth(platform);
          if (result.ok) {
            await options.repos.deliveries.markSent({
              id: delivery.id,
              providerMessageId: result.providerMessageId,
              providerIdempotencyKey: idempotencyKey,
            });
            options.bus?.emit('push:delivery.sent', {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              userId: subscription.userId,
              providerMessageId: result.providerMessageId,
              providerIdempotencyKey: idempotencyKey,
            });
            deliveredCount += 1;
            sent = true;
            break;
          }

          if (result.reason === 'invalidToken') {
            // P-PUSH-8: markFailed FIRST so the delivery record is in a
            // terminal state regardless of subsequent cleanup outcomes. If
            // the delete or membership purge fails, emit
            // `push:subscription.deletePending` so a sweeper can clean later
            // — never lose track of an orphaned subscription silently.
            await options.repos.deliveries.markFailed({
              id: delivery.id,
              failureReason: 'invalidToken',
            });
            try {
              await options.repos.subscriptions.delete(subscription.id);
            } catch (delErr) {
              logger.error(
                `[slingshot-push] Failed to delete invalid subscription="${sanitizeLogValue(subscription.id)}"`,
                errorLogFields(delErr),
              );
              options.bus?.emit('push:subscription.deletePending', {
                subscriptionId: subscription.id,
                userId: subscription.userId,
                platform,
                reason: result.error ?? 'invalidToken',
                error: delErr instanceof Error ? delErr.message : String(delErr),
              });
              sent = true;
              break;
            }
            try {
              await options.repos.topicMemberships.removeBySubscription({
                subscriptionId: subscription.id,
              });
            } catch (memErr) {
              logger.error(
                `[slingshot-push] Failed to remove memberships for subscription="${sanitizeLogValue(subscription.id)}"`,
                errorLogFields(memErr),
              );
              options.bus?.emit('push:subscription.deletePending', {
                subscriptionId: subscription.id,
                userId: subscription.userId,
                platform,
                reason: 'membership-cleanup-failed',
                error: memErr instanceof Error ? memErr.message : String(memErr),
              });
            }
            metrics.counter('push.subscription.cleanup.count', 1, {
              provider: platform,
              reason: 'invalidToken',
            });
            options.bus?.emit('push:delivery.failed', {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              userId: subscription.userId,
              reason: 'invalidToken',
            });
            options.bus?.emit('push:subscription.invalidated', {
              subscriptionId: subscription.id,
              userId: subscription.userId,
              platform,
              reason: result.error ?? 'invalidToken',
            });
            sent = true;
            break;
          }

          if (result.reason === 'payloadTooLarge') {
            await options.repos.deliveries.markFailed({
              id: delivery.id,
              failureReason: 'payloadTooLarge',
            });
            options.bus?.emit('push:delivery.failed', {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              userId: subscription.userId,
              reason: 'payloadTooLarge',
            });
            options.bus?.emit('push:message.payload_too_large', {
              platform,
              bytes: JSON.stringify(payload).length,
            });
            sent = true;
            break;
          }

          if (result.reason === 'permanent') {
            // Permanent provider failure (e.g. invalid OAuth credentials).
            // Stop retrying immediately but leave the subscription intact —
            // the failure is provider-config-level, not subscription-level.
            await options.repos.deliveries.markFailed({
              id: delivery.id,
              failureReason: 'permanent',
            });
            options.bus?.emit('push:delivery.failed', {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              userId: subscription.userId,
              reason: 'permanent',
              error: result.error,
            });
            sent = true;
            break;
          }

          if (attempts >= maxAttempts) {
            await options.repos.deliveries.markFailed({
              id: delivery.id,
              failureReason: result.reason ?? 'transient',
            });
            options.bus?.emit('push:delivery.failed', {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              userId: subscription.userId,
              reason: result.reason ?? 'transient',
            });
            sent = true;
            break;
          }

          const exponentialDelay = initialDelayMs * Math.pow(2, Math.max(0, attempts - 1));
          // Honor the provider's Retry-After hint when present and finite;
          // otherwise fall back to exponential backoff. Clamp to a sane upper
          // bound so a misbehaving upstream cannot pin a worker for hours.
          const requestedDelay =
            typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs)
              ? Math.max(0, result.retryAfterMs)
              : exponentialDelay;
          const delay = Math.min(requestedDelay, maxRetryDelayMs);
          try {
            await cancellableSleep(delay, lifecycleSignal);
          } catch {
            // Lifecycle abort: drop out of the retry loop without mutating
            // the delivery further. The fan-out caller will move on.
            break;
          }
        }
      } catch (err) {
        const safeDeliveryId = sanitizeLogValue(delivery.id);
        logger.error(
          `[slingshot-push] Repository failure during fan-out for delivery="${safeDeliveryId}"`,
          errorLogFields(err),
        );
        try {
          await options.repos.deliveries.markFailed({
            id: delivery.id,
            failureReason: 'repositoryFailure',
          });
        } catch (markErr) {
          logger.error(
            `[slingshot-push] Failed to mark delivery="${safeDeliveryId}" failed after repository error`,
            errorLogFields(markErr),
          );
        }
        options.bus?.emit('push:delivery.failed', {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          userId: subscription.userId,
          reason: 'repositoryFailure',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!sent) {
        try {
          await options.repos.deliveries.markFailed({
            id: delivery.id,
            failureReason: 'transient',
          });
        } catch (err) {
          logger.error(
            `[slingshot-push] Failed to mark delivery="${sanitizeLogValue(delivery.id)}" failed`,
            errorLogFields(err),
          );
        }
        options.bus?.emit('push:delivery.failed', {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          userId: subscription.userId,
          reason: 'transient',
        });
      }
    }

    return { delivered: deliveredCount, attempted: attemptedCount };
  }

  function summarize(result: { delivered: number; attempted: number }): PushSendResultSummary {
    return {
      delivered: result.delivered,
      attempted: result.attempted,
      allFailed: result.attempted > 0 && result.delivered === 0,
    };
  }

  async function sendToUser(
    userId: string,
    message: PushMessage,
    opts: { tenantId?: string; notificationId?: string; providerTimeoutMs?: number } = {},
  ): Promise<{ delivered: number; attempted: number }> {
    const tenantId = opts.tenantId ?? '';
    const subscriptions = asItems(
      await options.repos.subscriptions.listByUserId({ userId, tenantId }),
    );
    return sendToSubscriptions(subscriptions, message, {
      tenantId,
      notificationId: opts.notificationId,
      providerTimeoutMs: opts.providerTimeoutMs,
    });
  }

  return {
    async sendToUser(userId, message, opts = {}) {
      return guardRouterSend(async () => {
        const result = summarize(await sendToUser(userId, message, opts));
        if (result.allFailed) {
          recordRouterFailure();
        } else {
          recordRouterSuccess();
        }
        metrics.gauge('push.routerBreaker.state', CIRCUIT_STATE_VALUES[routerBreakerState] ?? 0);
        metrics.gauge('push.routerBreaker.failures', routerBreakerFailures);
        return result;
      });
    },
    async sendToUsers(userIds, message, opts = {}) {
      return guardRouterSend(async () => {
        const tenantId = opts.tenantId ?? '';
        let delivered = 0;
        let attempted = 0;
        for (const userId of [...new Set(userIds)]) {
          const r = await sendToUser(userId, message, {
            tenantId,
            notificationId: opts.notificationId,
            providerTimeoutMs: opts.providerTimeoutMs,
          });
          delivered += r.delivered;
          attempted += r.attempted;
        }
        const result = summarize({ delivered, attempted });
        if (result.allFailed) {
          recordRouterFailure();
        } else {
          recordRouterSuccess();
        }
        metrics.gauge('push.routerBreaker.state', CIRCUIT_STATE_VALUES[routerBreakerState] ?? 0);
        metrics.gauge('push.routerBreaker.failures', routerBreakerFailures);
        return result;
      });
    },
    async publishTopic(topicName, message, opts = {}) {
      return guardRouterSend(async () => {
        const tenantId = opts.tenantId ?? '';
        const topic = await options.repos.topics.findByName({ tenantId, name: topicName });
        if (!topic) {
          const emptyResult = summarize({ delivered: 0, attempted: 0 });
          metrics.gauge('push.routerBreaker.state', CIRCUIT_STATE_VALUES[routerBreakerState] ?? 0);
          metrics.gauge('push.routerBreaker.failures', routerBreakerFailures);
          return emptyResult;
        }

        const allMemberships = asItems(
          await options.repos.topicMemberships.listByTopic({ topicId: topic.id }),
        );
        // topicName is caller-supplied; sanitize before interpolating into a
        // log line so a hostile name cannot inject newlines and forge a
        // separate log record.
        const safeTopicName = sanitizeLogValue(topicName);

        // P-PUSH-11: hard cap topic fan-out at `topicMaxRecipients`. When
        // exceeded, emit `push:topic.fanout.truncated` with totals so
        // operators can see partial delivery without parsing logs, then
        // proceed with only the first `topicMaxRecipients` members. Callers
        // observe `truncated=true` on the returned summary.
        let memberships = allMemberships;
        let truncated = false;
        const totalMembers = allMemberships.length;
        if (memberships.length > topicMaxRecipients) {
          truncated = true;
          memberships = allMemberships.slice(0, topicMaxRecipients);
          logger.warn(
            `[slingshot-push] Topic '${safeTopicName}' has ${totalMembers} members; truncating to topicMaxRecipients=${topicMaxRecipients}.`,
          );
          options.bus?.emit('push:topic.fanout.truncated', {
            topicName,
            totalMembers,
            truncatedTo: topicMaxRecipients,
            dropped: totalMembers - topicMaxRecipients,
          });
        }
        metrics.counter('push.topic.fanout.count', memberships.length, { topic: topicName });

        // Chunk memberships into batches; resolve each batch's subscriptions in
        // parallel, then dispatch to subscribers. Apply back-pressure when the
        // number of pending batches exceeds `topicFanoutMaxPending` so a single
        // huge topic cannot overwhelm downstream providers.
        const allMembershipsLength = memberships.length;
        const totalBatches = Math.ceil(allMembershipsLength / topicFanoutBatchSize);
        const pending: Array<Promise<{ delivered: number; attempted: number }>> = [];
        let totalDelivered = 0;
        let totalAttempted = 0;
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
          if (pending.length >= topicFanoutMaxPending) {
            // Wait for at least one in-flight batch to settle before scheduling more.
            const settled = await Promise.race(
              pending.map((p, idx) => p.then(value => ({ value, idx }))),
            );
            totalDelivered += settled.value.delivered;
            totalAttempted += settled.value.attempted;
            pending.splice(settled.idx, 1);
          }
          const start = batchIndex * topicFanoutBatchSize;
          const end = Math.min(start + topicFanoutBatchSize, allMembershipsLength);
          const batchMemberships = memberships.slice(start, end);
          const dispatchPromise = (async () => {
            const subscriptionResults = await Promise.all(
              batchMemberships.map(m => options.repos.subscriptions.getById(m.subscriptionId)),
            );
            const subscriptions = subscriptionResults.filter(
              (s): s is RouterSubscriptionRecord => s !== null,
            );
            logger.info(
              `[slingshot-push] Topic '${safeTopicName}' batch ${batchIndex + 1}/${totalBatches} dispatched (size=${subscriptions.length}).`,
            );
            options.bus?.emit('push:topic.batch.dispatched', {
              topicName,
              batchIndex,
              totalBatches,
              size: subscriptions.length,
            });
            return sendToSubscriptions(subscriptions, message, {
              tenantId,
              notificationId: opts.notificationId,
              providerTimeoutMs: opts.providerTimeoutMs,
            });
          })();
          pending.push(dispatchPromise);
        }
        const remaining = await Promise.all(pending);
        for (const value of remaining) {
          totalDelivered += value.delivered;
          totalAttempted += value.attempted;
        }
        const summary = summarize({ delivered: totalDelivered, attempted: totalAttempted });
        if (summary.allFailed) {
          recordRouterFailure();
        } else {
          recordRouterSuccess();
        }
        metrics.gauge('push.routerBreaker.state', CIRCUIT_STATE_VALUES[routerBreakerState] ?? 0);
        metrics.gauge('push.routerBreaker.failures', routerBreakerFailures);
        if (!truncated) {
          return summary;
        }
        const truncatedSummary: PushSendResultSummary & {
          truncated: true;
          totalMembers: number;
        } = { ...summary, truncated: true, totalMembers };
        return truncatedSummary;
      }); // guardRouterSend
    },
    stop(): void {
      lifecycleController.abort();
    },
    getBreakerHealth(): {
      readonly circuitState: 'closed' | 'open' | 'half-open';
      readonly consecutiveFailures: number;
    } | null {
      if (routerBreakerThreshold === 0) return null;
      return { circuitState: routerBreakerState, consecutiveFailures: routerBreakerFailures };
    },
  };
}

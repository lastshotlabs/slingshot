import type { MetricsEmitter } from '@lastshotlabs/slingshot-core';
import { createNoopMetricsEmitter, sanitizeLogValue } from '@lastshotlabs/slingshot-core';
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithProviderTimeout(
  provider: PushProvider,
  subscription: PushSubscriptionRecord,
  message: PushMessage,
  timeoutMs: number,
  context: PushProviderSendContext,
): Promise<PushSendResult> {
  if (timeoutMs <= 0) return provider.send(subscription, message, context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.send(subscription, message, context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`push provider timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
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
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<PushSendResultSummary>;
  sendToUsers(
    userIds: readonly string[],
    message: PushMessage,
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<PushSendResultSummary>;
  publishTopic(
    topicName: string,
    message: PushMessage,
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<PushSendResultSummary>;
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
}): PushRouter {
  const maxAttempts = options.retries?.maxAttempts ?? 3;
  const initialDelayMs = options.retries?.initialDelayMs ?? 1_000;
  // Upper bound on a single retry-wait, to clamp absurd `Retry-After` hints
  // (e.g. a server returning hours) and prevent worker starvation.
  const maxRetryDelayMs = options.retries?.maxDelayMs ?? 5 * 60_000;
  const providerTimeoutMs = options.providerTimeoutMs ?? 30_000;
  const topicFanoutBatchSize = Math.max(1, options.topicFanoutBatchSize ?? 1000);
  const topicFanoutMaxPending = Math.max(1, options.topicFanoutMaxPending ?? 10);
  const metrics: MetricsEmitter = options.metrics ?? createNoopMetricsEmitter();

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
    opts: { tenantId: string; notificationId?: string },
  ): Promise<{ delivered: number; attempted: number }> {
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
        console.error(
          `[slingshot-push] Failed to create delivery for subscription="${sanitizeLogValue(subscription.id)}"`,
          err,
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
              providerTimeoutMs,
              { idempotencyKey },
            );
          } catch (err) {
            console.error(
              `[slingshot-push] Provider threw or timed out for platform="${sanitizeLogValue(platform)}" userId="${sanitizeLogValue(subscription.userId)}"`,
              err,
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
            await options.repos.deliveries.markFailed({
              id: delivery.id,
              failureReason: 'invalidToken',
            });
            await options.repos.subscriptions.delete(subscription.id);
            await options.repos.topicMemberships.removeBySubscription({
              subscriptionId: subscription.id,
            });
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
          await sleep(delay);
        }
      } catch (err) {
        const safeDeliveryId = sanitizeLogValue(delivery.id);
        console.error(
          `[slingshot-push] Repository failure during fan-out for delivery="${safeDeliveryId}"`,
          err,
        );
        try {
          await options.repos.deliveries.markFailed({
            id: delivery.id,
            failureReason: 'repositoryFailure',
          });
        } catch (markErr) {
          console.error(
            `[slingshot-push] Failed to mark delivery="${safeDeliveryId}" failed after repository error`,
            markErr,
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
          console.error(
            `[slingshot-push] Failed to mark delivery="${sanitizeLogValue(delivery.id)}" failed`,
            err,
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
    opts: { tenantId?: string; notificationId?: string } = {},
  ): Promise<{ delivered: number; attempted: number }> {
    const tenantId = opts.tenantId ?? '';
    const subscriptions = asItems(
      await options.repos.subscriptions.listByUserId({ userId, tenantId }),
    );
    return sendToSubscriptions(subscriptions, message, {
      tenantId,
      notificationId: opts.notificationId,
    });
  }

  return {
    async sendToUser(userId, message, opts = {}) {
      return summarize(await sendToUser(userId, message, opts));
    },
    async sendToUsers(userIds, message, opts = {}) {
      const tenantId = opts.tenantId ?? '';
      let delivered = 0;
      let attempted = 0;
      for (const userId of [...new Set(userIds)]) {
        const r = await sendToUser(userId, message, {
          tenantId,
          notificationId: opts.notificationId,
        });
        delivered += r.delivered;
        attempted += r.attempted;
      }
      return summarize({ delivered, attempted });
    },
    async publishTopic(topicName, message, opts = {}) {
      const tenantId = opts.tenantId ?? '';
      const topic = await options.repos.topics.findByName({ tenantId, name: topicName });
      if (!topic) return summarize({ delivered: 0, attempted: 0 });

      const LARGE_TOPIC_WARNING_THRESHOLD = 10_000;
      const allMemberships = asItems(
        await options.repos.topicMemberships.listByTopic({ topicId: topic.id }),
      );
      metrics.counter('push.topic.fanout.count', allMemberships.length, { topic: topicName });
      // topicName is caller-supplied; sanitize before interpolating into a
      // log line so a hostile name cannot inject newlines and forge a
      // separate log record.
      const safeTopicName = sanitizeLogValue(topicName);
      if (allMemberships.length > LARGE_TOPIC_WARNING_THRESHOLD) {
        console.warn(
          `[slingshot-push] Topic '${safeTopicName}' has ${allMemberships.length} members; publishing in batched fan-out (batchSize=${topicFanoutBatchSize}, maxPending=${topicFanoutMaxPending}).`,
        );
      }

      // Chunk memberships into batches; resolve each batch's subscriptions in
      // parallel, then dispatch to subscribers. Apply back-pressure when the
      // number of pending batches exceeds `topicFanoutMaxPending` so a single
      // huge topic cannot overwhelm downstream providers.
      const totalBatches = Math.ceil(allMemberships.length / topicFanoutBatchSize);
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
        const end = Math.min(start + topicFanoutBatchSize, allMemberships.length);
        const batchMemberships = allMemberships.slice(start, end);
        const dispatchPromise = (async () => {
          const subscriptionResults = await Promise.all(
            batchMemberships.map(m => options.repos.subscriptions.getById(m.subscriptionId)),
          );
          const subscriptions = subscriptionResults.filter(
            (s): s is RouterSubscriptionRecord => s !== null,
          );
          console.info(
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
          });
        })();
        pending.push(dispatchPromise);
      }
      const remaining = await Promise.all(pending);
      for (const value of remaining) {
        totalDelivered += value.delivered;
        totalAttempted += value.attempted;
      }
      return summarize({ delivered: totalDelivered, attempted: totalAttempted });
    },
  };
}

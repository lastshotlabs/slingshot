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

/** Router API used for user fan-out and topic publishes. */
export interface PushRouter {
  sendToUser(
    userId: string,
    message: PushMessage,
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<number>;
  sendToUsers(
    userIds: readonly string[],
    message: PushMessage,
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<number>;
  publishTopic(
    topicName: string,
    message: PushMessage,
    opts?: { tenantId?: string; notificationId?: string },
  ): Promise<number>;
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
  retries?: { maxAttempts?: number; initialDelayMs?: number };
  bus?: DynamicBus;
  /** Maximum milliseconds for a single provider.send() call before it is treated as transient failure. Default: 30000. */
  providerTimeoutMs?: number;
  /** Subscriptions per topic-fan-out batch. Default: 1000. */
  topicFanoutBatchSize?: number;
  /** Max concurrent in-flight batches before back-pressure kicks in. Default: 10. */
  topicFanoutMaxPending?: number;
}): PushRouter {
  const maxAttempts = options.retries?.maxAttempts ?? 3;
  const initialDelayMs = options.retries?.initialDelayMs ?? 1_000;
  const providerTimeoutMs = options.providerTimeoutMs ?? 30_000;
  const topicFanoutBatchSize = Math.max(1, options.topicFanoutBatchSize ?? 1000);
  const topicFanoutMaxPending = Math.max(1, options.topicFanoutMaxPending ?? 10);

  async function sendToSubscriptions(
    subscriptions: readonly RouterSubscriptionRecord[],
    message: PushMessage,
    opts: { tenantId: string; notificationId?: string },
  ): Promise<number> {
    let deliveredCount = 0;

    for (const subscription of subscriptions) {
      const platform = toPushPlatform(subscription.platform);
      if (!platform) continue;

      const provider = options.providers[platform];
      if (!provider) continue;

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
        console.error(
          `[slingshot-push] Failed to create delivery for subscription="${subscription.id}"`,
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
              `[slingshot-push] Provider threw or timed out for platform="${platform}" userId="${subscription.userId}"`,
              err,
            );
            result = {
              ok: false,
              reason: 'transient' as const,
              error: err instanceof Error ? err.message : 'push provider threw or timed out',
            };
          }
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

          const delay =
            result.retryAfterMs ?? initialDelayMs * Math.pow(2, Math.max(0, attempts - 1));
          await sleep(delay);
        }
      } catch (err) {
        console.error(
          `[slingshot-push] Repository failure during fan-out for delivery="${delivery.id}"`,
          err,
        );
        try {
          await options.repos.deliveries.markFailed({
            id: delivery.id,
            failureReason: 'repositoryFailure',
          });
        } catch (markErr) {
          console.error(
            `[slingshot-push] Failed to mark delivery="${delivery.id}" failed after repository error`,
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
          console.error(`[slingshot-push] Failed to mark delivery="${delivery.id}" failed`, err);
        }
        options.bus?.emit('push:delivery.failed', {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          userId: subscription.userId,
          reason: 'transient',
        });
      }
    }

    return deliveredCount;
  }

  async function sendToUser(
    userId: string,
    message: PushMessage,
    opts: { tenantId?: string; notificationId?: string } = {},
  ): Promise<number> {
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
      return sendToUser(userId, message, opts);
    },
    async sendToUsers(userIds, message, opts = {}) {
      const tenantId = opts.tenantId ?? '';
      let count = 0;
      for (const userId of [...new Set(userIds)]) {
        count += await sendToUser(userId, message, {
          tenantId,
          notificationId: opts.notificationId,
        });
      }
      return count;
    },
    async publishTopic(topicName, message, opts = {}) {
      const tenantId = opts.tenantId ?? '';
      const topic = await options.repos.topics.findByName({ tenantId, name: topicName });
      if (!topic) return 0;

      const LARGE_TOPIC_WARNING_THRESHOLD = 10_000;
      const allMemberships = asItems(
        await options.repos.topicMemberships.listByTopic({ topicId: topic.id }),
      );
      if (allMemberships.length > LARGE_TOPIC_WARNING_THRESHOLD) {
        console.warn(
          `[slingshot-push] Topic '${topicName}' has ${allMemberships.length} members; publishing in batched fan-out (batchSize=${topicFanoutBatchSize}, maxPending=${topicFanoutMaxPending}).`,
        );
      }

      // Chunk memberships into batches; resolve each batch's subscriptions in
      // parallel, then dispatch to subscribers. Apply back-pressure when the
      // number of pending batches exceeds `topicFanoutMaxPending` so a single
      // huge topic cannot overwhelm downstream providers.
      const totalBatches = Math.ceil(allMemberships.length / topicFanoutBatchSize);
      const pending: Array<Promise<number>> = [];
      let totalDelivered = 0;
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        if (pending.length >= topicFanoutMaxPending) {
          // Wait for at least one in-flight batch to settle before scheduling more.
          const settled = await Promise.race(
            pending.map((p, idx) => p.then(value => ({ value, idx }))),
          );
          totalDelivered += settled.value;
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
            `[slingshot-push] Topic '${topicName}' batch ${batchIndex + 1}/${totalBatches} dispatched (size=${subscriptions.length}).`,
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
      for (const value of remaining) totalDelivered += value;
      return totalDelivered;
    },
  };
}

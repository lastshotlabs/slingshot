/**
 * Topic fan-out edge cases.
 *
 * Covers scenarios the load and batching tests do not exercise: empty topics,
 * truncation at the recipient cap, mixed success/failure within a single
 * fan-out, and subscriptions that expired (null when resolved) between the
 * membership snapshot and delivery.
 *
 * The router under test is `createPushRouter` with stubbed repositories and
 * providers — no network, no real persistence.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { PushProvider } from '../../src/providers/provider';
import { type PushRouterRepos, createPushRouter } from '../../src/router';
import type {
  PushDeliveryRecord,
  PushMessage,
  PushSendResult,
  PushSubscriptionRecord,
  PushTopicMembershipRecord,
} from '../../src/types/models';

let idCounter = 0;
function nextId(): string {
  return `id-${++idCounter}`;
}

function makeSubscription(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: nextId(),
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'web',
    platformData: {
      platform: 'web',
      endpoint: 'https://example.com/push',
      keys: { p256dh: 'k', auth: 'a' },
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

function makeMembership(
  overrides: Partial<PushTopicMembershipRecord> = {},
): PushTopicMembershipRecord {
  return {
    id: nextId(),
    topicId: 'topic-1',
    subscriptionId: 'sub-1',
    userId: 'user-1',
    tenantId: '',
    createdAt: new Date(),
    ...overrides,
  };
}

function createFakeRepos(): PushRouterRepos & {
  _subscriptions: Map<string, PushSubscriptionRecord>;
  _topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }>;
  _memberships: PushTopicMembershipRecord[];
  _deliveries: PushDeliveryRecord[];
} {
  const subscriptions = new Map<string, PushSubscriptionRecord>();
  const topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }> = [];
  const memberships: PushTopicMembershipRecord[] = [];
  const deliveries: PushDeliveryRecord[] = [];

  return {
    _subscriptions: subscriptions,
    _topics: topics,
    _memberships: memberships,
    _deliveries: deliveries,

    subscriptions: {
      create: async () => {
        throw new Error('not used in topic fan-out tests');
      },
      getById: async id => subscriptions.get(id) ?? null,
      delete: async id => subscriptions.delete(id),
      listByUserId: async () => ({ items: [] }),
      findByDevice: async () => null,
      touchLastSeen: async () => {
        throw new Error('not used');
      },
      upsertByDevice: async () => {
        throw new Error('not used');
      },
    },
    topics: {
      ensureByName: async ({ tenantId, name }) => {
        let t = topics.find(x => x.tenantId === tenantId && x.name === name);
        if (!t) {
          t = { id: nextId(), tenantId, name, createdAt: new Date() };
          topics.push(t);
        }
        return t;
      },
      findByName: async ({ tenantId, name }) =>
        topics.find(t => t.tenantId === tenantId && t.name === name) ?? null,
    },
    topicMemberships: {
      ensureMembership: async () => {
        throw new Error('not used');
      },
      listByTopic: async ({ topicId }) => ({
        items: memberships.filter(m => m.topicId === topicId),
      }),
      removeByTopicAndSub: async () => ({ count: 0 }),
      removeBySubscription: async () => ({ count: 0 }),
    },
    deliveries: {
      create: async input => {
        const i = input as Record<string, unknown>;
        const delivery: PushDeliveryRecord = {
          id: nextId(),
          tenantId: (i['tenantId'] as string) ?? '',
          userId: i['userId'] as string,
          subscriptionId: i['subscriptionId'] as string,
          platform: (i['platform'] as 'web' | 'ios' | 'android') ?? 'web',
          notificationId: null,
          providerMessageId: null,
          status: 'pending',
          failureReason: null,
          attempts: 0,
          sentAt: null,
          deliveredAt: null,
          createdAt: new Date(),
        };
        deliveries.push(delivery);
        return delivery;
      },
      getById: async id => deliveries.find(d => d.id === id) ?? null,
      markSent: async ({ id, providerMessageId, providerIdempotencyKey }) => {
        const d = deliveries.find(x => x.id === id);
        if (!d) return null;
        Object.assign(d, {
          status: 'sent',
          sentAt: new Date(),
          providerMessageId,
          providerIdempotencyKey,
        });
        return d;
      },
      markDelivered: async () => null,
      markFailed: async ({ id, failureReason }) => {
        const d = deliveries.find(x => x.id === id);
        if (!d) return null;
        Object.assign(d, { status: 'failed', failureReason });
        return d;
      },
      incrementAttempts: async (id: string) => {
        const d = deliveries.find(x => x.id === id);
        if (d) Object.assign(d, { attempts: d.attempts + 1 });
        return d ?? {};
      },
    },
  };
}

beforeEach(() => {
  idCounter = 0;
});

const MESSAGE: PushMessage = { title: 'Test notification' };

// ---------------------------------------------------------------------------
// 1. Fan-out with no subscribers (empty topic)
// ---------------------------------------------------------------------------
describe('topic fan-out with empty / non-existent topics', () => {
  test('publish to a topic that has never been created returns empty (allFailed false)', async () => {
    const repos = createFakeRepos();
    const provider: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: true }),
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      bus,
    });

    const result = await router.publishTopic('nonexistent', MESSAGE);

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(0);
    // No subscriptions to attempt is NOT a failure — allFailed is false.
    expect(result.allFailed).toBe(false);
    // No batches dispatched and no deliveries created.
    expect(repos._deliveries).toHaveLength(0);
    const batchEvents = events.filter(e => e.event === 'push:topic.batch.dispatched');
    expect(batchEvents).toHaveLength(0);
  });

  test('publish to a topic that exists but has zero members returns empty', async () => {
    const repos = createFakeRepos();
    const provider: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: true }),
    };
    const bus = { emit: () => {} };

    // Create the topic with no members.
    repos._topics.push({ id: 'empty-topic', tenantId: '', name: 'empty', createdAt: new Date() });

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      bus,
    });

    const result = await router.publishTopic('empty', MESSAGE);

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(0);
    expect(result.allFailed).toBe(false);
    expect(repos._deliveries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Fan-out with many subscribers (batching behavior)
// ---------------------------------------------------------------------------
describe('topic fan-out batching with many subscribers', () => {
  test('delivers to 1000 subscribers split across multiple batches', async () => {
    const repos = createFakeRepos();
    const sendCountsBySubId = new Map<string, number>();
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        sendCountsBySubId.set(sub.id, (sendCountsBySubId.get(sub.id) ?? 0) + 1);
        return { ok: true };
      },
    };

    const topic = { id: 'many-topic', tenantId: '', name: 'many', createdAt: new Date() };
    repos._topics.push(topic);

    const N = 1000;
    const BATCH_SIZE = 250;
    for (let i = 0; i < N; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: BATCH_SIZE,
      topicFanoutMaxPending: 4,
      bus,
    });

    const result = await router.publishTopic('many', MESSAGE);

    expect(result.delivered).toBe(N);
    expect(result.attempted).toBe(N);
    expect(result.allFailed).toBe(false);
    expect(sendCountsBySubId.size).toBe(N);
    for (const c of sendCountsBySubId.values()) {
      expect(c).toBe(1);
    }

    // 1000 / 250 = 4 batches exactly.
    const batchEvents = events.filter(e => e.event === 'push:topic.batch.dispatched');
    expect(batchEvents).toHaveLength(N / BATCH_SIZE);
    for (const e of batchEvents) {
      expect((e.payload as { size: number }).size).toBe(BATCH_SIZE);
    }
  });

  test('partial batch when subscriber count is not evenly divisible by batch size', async () => {
    const repos = createFakeRepos();
    const sendCountsBySubId = new Map<string, number>();
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        sendCountsBySubId.set(sub.id, (sendCountsBySubId.get(sub.id) ?? 0) + 1);
        return { ok: true };
      },
    };

    const topic = { id: 'odd-topic', tenantId: '', name: 'odd', createdAt: new Date() };
    repos._topics.push(topic);

    const N = 7;
    const BATCH_SIZE = 3;
    for (let i = 0; i < N; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: BATCH_SIZE,
      topicFanoutMaxPending: 2,
      bus,
    });

    const result = await router.publishTopic('odd', MESSAGE);

    // All 7 delivered across 3 batches: 3 + 3 + 1
    expect(result.delivered).toBe(N);
    expect(result.attempted).toBe(N);
    expect(result.allFailed).toBe(false);
    expect(sendCountsBySubId.size).toBe(N);

    const batchEvents = events.filter(e => e.event === 'push:topic.batch.dispatched');
    expect(batchEvents).toHaveLength(Math.ceil(N / BATCH_SIZE)); // 3 batches
    // Last batch has the remaining 1 subscriber.
    const lastBatch = batchEvents[batchEvents.length - 1]!;
    expect((lastBatch.payload as { size: number }).size).toBe(N % BATCH_SIZE);
  });
});

// ---------------------------------------------------------------------------
// 3. Fan-out truncation when subscriber count exceeds cap
// ---------------------------------------------------------------------------
describe('topic fan-out truncation (P-PUSH-11)', () => {
  test('truncates when subscriber count exceeds topicMaxRecipients', async () => {
    const repos = createFakeRepos();
    const sendIds: string[] = [];
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        sendIds.push(sub.id);
        return { ok: true };
      },
    };

    const topic = { id: 'big-topic', tenantId: '', name: 'big', createdAt: new Date() };
    repos._topics.push(topic);

    const MAX_RECIPIENTS = 100;
    const TOTAL_MEMBERS = 150;
    for (let i = 0; i < TOTAL_MEMBERS; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicMaxRecipients: MAX_RECIPIENTS,
      topicFanoutBatchSize: 50,
      topicFanoutMaxPending: 2,
      bus,
    });

    const result = await router.publishTopic('big', MESSAGE);

    // Only MAX_RECIPIENTS subscriptions were attempted, the rest dropped.
    expect(result.delivered).toBe(MAX_RECIPIENTS);
    expect(result.attempted).toBe(MAX_RECIPIENTS);
    expect(result.allFailed).toBe(false);
    expect(sendIds).toHaveLength(MAX_RECIPIENTS);

    // Confirm the first MAX_RECIPIENTS subs were sent, the extras were not.
    for (let i = 0; i < MAX_RECIPIENTS; i += 1) {
      expect(sendIds).toContain(`sub-${i}`);
    }
    for (let i = MAX_RECIPIENTS; i < TOTAL_MEMBERS; i += 1) {
      expect(sendIds).not.toContain(`sub-${i}`);
    }

    // Truncated event was emitted with correct totals.
    const truncatedEvent = events.find(e => e.event === 'push:topic.fanout.truncated');
    expect(truncatedEvent).toBeDefined();
    const p = truncatedEvent!.payload as {
      topicName: string;
      totalMembers: number;
      truncatedTo: number;
      dropped: number;
    };
    expect(p.topicName).toBe('big');
    expect(p.totalMembers).toBe(TOTAL_MEMBERS);
    expect(p.truncatedTo).toBe(MAX_RECIPIENTS);
    expect(p.dropped).toBe(TOTAL_MEMBERS - MAX_RECIPIENTS);

    // Summary includes truncated metadata at the type level (runtime check).
    expect((result as { truncated?: boolean }).truncated).toBe(true);
    expect((result as { totalMembers?: number }).totalMembers).toBe(TOTAL_MEMBERS);
  });

  test('does NOT truncate when subscriber count is exactly at topicMaxRecipients', async () => {
    const repos = createFakeRepos();
    const sendIds: string[] = [];
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        sendIds.push(sub.id);
        return { ok: true };
      },
    };

    const topic = { id: 'exact-topic', tenantId: '', name: 'exact', createdAt: new Date() };
    repos._topics.push(topic);

    const LIMIT = 50;
    for (let i = 0; i < LIMIT; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicMaxRecipients: LIMIT,
      topicFanoutBatchSize: 50,
      bus,
    });

    const result = await router.publishTopic('exact', MESSAGE);

    // All 50 delivered; no truncation.
    expect(result.delivered).toBe(LIMIT);
    expect(result.attempted).toBe(LIMIT);
    expect((result as { truncated?: boolean }).truncated).toBeUndefined();

    const truncatedEvent = events.find(e => e.event === 'push:topic.fanout.truncated');
    expect(truncatedEvent).toBeUndefined();
  });

  test('truncation at cap still properly reports allFailed when every truncated send fails', async () => {
    const repos = createFakeRepos();
    const provider: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'transient' }),
    };

    const topic = { id: 'fail-topic', tenantId: '', name: 'fail', createdAt: new Date() };
    repos._topics.push(topic);

    const MAX_RECIPIENTS = 10;
    const TOTAL_MEMBERS = 25;
    for (let i = 0; i < TOTAL_MEMBERS; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicMaxRecipients: MAX_RECIPIENTS,
      topicFanoutBatchSize: 50,
    });

    const result = await router.publishTopic('fail', MESSAGE);

    // All 10 attempted deliveries failed.
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(MAX_RECIPIENTS);
    expect(result.allFailed).toBe(true);
    expect((result as { truncated?: boolean }).truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Mixed valid/invalid device tokens in fan-out
// ---------------------------------------------------------------------------
describe('topic fan-out with mixed valid/invalid tokens', () => {
  test('some subscriptions succeed, some fail with invalidToken, some with transient', async () => {
    const repos = createFakeRepos();

    // Map subscription IDs to their send outcomes.
    const sendBehavior = new Map<string, () => Promise<PushSendResult>>();
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        const behavior = sendBehavior.get(sub.id);
        if (behavior) return behavior();
        return { ok: true };
      },
    };

    const topic = { id: 'mixed-topic', tenantId: '', name: 'mixed', createdAt: new Date() };
    repos._topics.push(topic);

    const TOTAL = 8;
    const subscriptions: PushSubscriptionRecord[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const sub = makeSubscription({
        id: `mixed-sub-${i}`,
        userId: `u-${i}`,
        deviceId: `d-${i}`,
      });
      subscriptions.push(sub);
      repos._subscriptions.set(sub.id, sub);
      repos._memberships.push({
        id: `mixed-m-${i}`,
        topicId: topic.id,
        subscriptionId: sub.id,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    // Assign behaviors:
    // sub-0, sub-1: success
    // sub-2: invalidToken (gets cleaned up)
    // sub-3: transient (retry exhaustion)
    // sub-4: success
    // sub-5: payloadTooLarge
    // sub-6, sub-7: transient
    sendBehavior.set('mixed-sub-0', async () => ({ ok: true, providerMessageId: 'msg-0' }));
    sendBehavior.set('mixed-sub-1', async () => ({ ok: true, providerMessageId: 'msg-1' }));
    sendBehavior.set('mixed-sub-2', async () => ({
      ok: false,
      reason: 'invalidToken',
      error: 'BadDeviceToken',
    }));
    sendBehavior.set('mixed-sub-3', async () => ({ ok: false, reason: 'transient' }));
    sendBehavior.set('mixed-sub-4', async () => ({ ok: true, providerMessageId: 'msg-4' }));
    sendBehavior.set('mixed-sub-5', async () => ({ ok: false, reason: 'payloadTooLarge' }));
    sendBehavior.set('mixed-sub-6', async () => ({ ok: false, reason: 'transient' }));
    sendBehavior.set('mixed-sub-7', async () => ({ ok: false, reason: 'transient' }));

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
      topicFanoutBatchSize: 50,
      bus,
    });

    const result = await router.publishTopic('mixed', MESSAGE);

    // Some succeeded, some failed — not all failed, and attempted matches total.
    expect(result.delivered).toBe(3);
    expect(result.attempted).toBe(TOTAL);
    expect(result.allFailed).toBe(false);

    // The invalidToken sub was deleted from the subscription store.
    expect(repos._subscriptions.has('mixed-sub-2')).toBe(false);
    // All other subs remain (including transient-failed ones).
    expect(repos._subscriptions.has('mixed-sub-0')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-1')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-3')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-4')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-5')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-6')).toBe(true);
    expect(repos._subscriptions.has('mixed-sub-7')).toBe(true);

    // One failure event per failed subscription.
    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(5); // invalidToken + transient + payloadTooLarge + 2x transient
    const reasons = failedEvents.map(e => (e.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual([
      'invalidToken',
      'payloadTooLarge',
      'transient',
      'transient',
      'transient',
    ]);

    // invalidToken triggers an invalidation event.
    const invalidated = events.filter(e => e.event === 'push:subscription.invalidated');
    expect(invalidated).toHaveLength(1);
    expect((invalidated[0]!.payload as { subscriptionId: string }).subscriptionId).toBe(
      'mixed-sub-2',
    );

    // payloadTooLarge triggers a dedicated event.
    const tooLarge = events.filter(e => e.event === 'push:message.payload_too_large');
    expect(tooLarge).toHaveLength(1);
  });

  test('all subscriptions fail with mixed reasons — allFailed true', async () => {
    const repos = createFakeRepos();
    const sendBehavior = new Map<string, () => Promise<PushSendResult>>();
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        const behavior = sendBehavior.get(sub.id);
        if (behavior) return behavior();
        return { ok: false, reason: 'transient' };
      },
    };

    const topic = { id: 'all-fail-topic', tenantId: '', name: 'all-fail', createdAt: new Date() };
    repos._topics.push(topic);

    for (let i = 0; i < 4; i += 1) {
      const subId = `fail-sub-${i}`;
      repos._subscriptions.set(
        subId,
        makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` }),
      );
      repos._memberships.push({
        id: `fail-m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    sendBehavior.set('fail-sub-0', async () => ({ ok: false, reason: 'invalidToken' }));
    sendBehavior.set('fail-sub-1', async () => ({
      ok: false,
      reason: 'permanent',
      error: 'auth down',
    }));
    sendBehavior.set('fail-sub-2', async () => ({ ok: false, reason: 'payloadTooLarge' }));
    sendBehavior.set('fail-sub-3', async () => ({ ok: false, reason: 'transient' }));

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
      topicFanoutBatchSize: 50,
    });

    const result = await router.publishTopic('all-fail', MESSAGE);

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(4);
    expect(result.allFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Fan-out with expired subscriptions
// ---------------------------------------------------------------------------
describe('topic fan-out with expired / stale subscriptions', () => {
  test('subscriptions that return null from getById are silently omitted', async () => {
    const repos = createFakeRepos();

    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        return { ok: true, providerMessageId: `msg-${sub.id}` };
      },
    };

    const topic = { id: 'stale-topic', tenantId: '', name: 'stale', createdAt: new Date() };
    repos._topics.push(topic);

    // Create 5 memberships, but only 3 have live subscriptions in the store.
    const liveIds = ['live-0', 'live-1', 'live-2'];
    const expiredIds = ['dead-0', 'dead-1'];

    for (const id of liveIds) {
      repos._subscriptions.set(id, makeSubscription({ id, userId: 'u-live', deviceId: `d-${id}` }));
    }
    // dead-0 and dead-1 are intentionally NOT in the subscriptions map.

    // All 5 appear as memberships.
    for (const id of [...liveIds, ...expiredIds]) {
      repos._memberships.push({
        id: `m-${id}`,
        topicId: topic.id,
        subscriptionId: id,
        userId: 'u-live',
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: 50,
      bus,
    });

    const result = await router.publishTopic('stale', MESSAGE);

    // Only the 3 live subscriptions received delivery attempts.
    expect(result.delivered).toBe(3);
    expect(result.attempted).toBe(3);
    expect(result.allFailed).toBe(false);

    // Exactly 3 deliveries were persisted.
    expect(repos._deliveries).toHaveLength(3);
    const subIds = repos._deliveries.map(d => d.subscriptionId).sort();
    expect(subIds).toEqual(['live-0', 'live-1', 'live-2']);

    // No failure events for the expired subs — they are simply skipped.
    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(0);
  });

  test('all subscriptions expired — nothing to deliver', async () => {
    const repos = createFakeRepos();

    const provider: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: true }),
    };

    const topic = { id: 'all-dead-topic', tenantId: '', name: 'all-dead', createdAt: new Date() };
    repos._topics.push(topic);

    // All memberships point to subs that no longer exist.
    for (let i = 0; i < 5; i += 1) {
      repos._memberships.push({
        id: `m-dead-${i}`,
        topicId: topic.id,
        subscriptionId: `gone-${i}`,
        userId: 'u-gone',
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: 50,
    });

    const result = await router.publishTopic('all-dead', MESSAGE);

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(0);
    // No subscriptions were attempted (all expired) — not a failure.
    expect(result.allFailed).toBe(false);
    expect(repos._deliveries).toHaveLength(0);
  });

  test('mixed expired and live with some live subscriptions failing', async () => {
    const repos = createFakeRepos();

    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        // live-0 succeeds; live-1 fails permanently.
        if (sub.id === 'live-1') {
          return { ok: false, reason: 'permanent', error: 'down' };
        }
        return { ok: true, providerMessageId: `msg-${sub.id}` };
      },
    };

    const topic = {
      id: 'mixed-stale-topic',
      tenantId: '',
      name: 'mixed-stale',
      createdAt: new Date(),
    };
    repos._topics.push(topic);

    // 2 live subs, 2 expired subs.
    repos._subscriptions.set(
      'live-0',
      makeSubscription({ id: 'live-0', userId: 'u-mix', deviceId: 'd-live-0' }),
    );
    repos._subscriptions.set(
      'live-1',
      makeSubscription({ id: 'live-1', userId: 'u-mix', deviceId: 'd-live-1' }),
    );

    for (const id of ['live-0', 'live-1', 'dead-0', 'dead-1']) {
      repos._memberships.push({
        id: `m-${id}`,
        topicId: topic.id,
        subscriptionId: id,
        userId: 'u-mix',
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: 50,
      bus,
    });

    const result = await router.publishTopic('mixed-stale', MESSAGE);

    // 1 delivered, 1 attempted but failed, 2 expired = skipped.
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.allFailed).toBe(false);

    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.payload as { subscriptionId: string }).subscriptionId).toBe('live-1');
  });
});

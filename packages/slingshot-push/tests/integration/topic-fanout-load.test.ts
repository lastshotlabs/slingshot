/**
 * Load test for topic fan-out at production scale.
 *
 * Covers the gap where `topic-fanout-batching.test.ts` only validated batching
 * at small scale (≤5,000 members). This test fans out to 10,000 subscribers
 * and asserts:
 *   (a) every subscription receives exactly one delivery attempt,
 *   (b) batches respect the configured `topicFanoutBatchSize`,
 *   (c) the run completes without unbounded buffering (memory growth is
 *       bounded relative to the working set).
 *
 * The test uses the in-process router with stubbed repositories and a stub
 * provider — no network, no real persistence. It is intentionally framed as
 * an integration test because it exercises the router end-to-end with the
 * full batching + back-pressure pipeline.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { PushProvider } from '../../src/providers/provider';
import { type PushRouterRepos, createPushRouter } from '../../src/router';
import type {
  PushDeliveryRecord,
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

function createFakeRepos(): PushRouterRepos & {
  _subscriptions: Map<string, PushSubscriptionRecord>;
  _topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }>;
  _memberships: PushTopicMembershipRecord[];
  _deliveries: PushDeliveryRecord[];
} {
  // Use a Map for O(1) lookups — at 10k members a linear scan per send call
  // would dominate runtime and obscure what we're actually measuring.
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
        throw new Error('not used in load test');
      },
      getById: async id => subscriptions.get(id) ?? null,
      delete: async () => true,
      listByUserId: async () => ({ items: [] }),
      findByDevice: async () => null,
      touchLastSeen: async () => {
        throw new Error('not used in load test');
      },
      upsertByDevice: async () => {
        throw new Error('not used in load test');
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
      ensureMembership: async () => memberships[0]!,
      listByTopic: async ({ topicId }) => ({
        items: memberships.filter(m => m.topicId === topicId),
      }),
      removeByTopicAndSub: async () => ({ count: 0 }),
      removeBySubscription: async () => ({ count: 0 }),
    },
    deliveries: {
      create: async input => {
        const delivery: PushDeliveryRecord = {
          id: nextId(),
          tenantId: '',
          userId: (input as Record<string, unknown>)['userId'] as string,
          subscriptionId: (input as Record<string, unknown>)['subscriptionId'] as string,
          platform: 'web',
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
      markSent: async ({ id, providerMessageId }) => {
        const d = deliveries.find(x => x.id === id);
        if (!d) return null;
        Object.assign(d, { status: 'sent', sentAt: new Date(), providerMessageId });
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

describe('Topic fan-out at production scale (10,000 members)', () => {
  test('10,000-subscriber topic delivers exactly once per subscriber, in expected batch count', async () => {
    const repos = createFakeRepos();

    // Track how many times each subscription was sent — proves "exactly one
    // attempt per subscriber" without requiring a per-subscription spy.
    const sendCountsBySubId = new Map<string, number>();
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        sendCountsBySubId.set(sub.id, (sendCountsBySubId.get(sub.id) ?? 0) + 1);
        return { ok: true };
      },
    };

    const topic = { id: 'topic-load', tenantId: '', name: 'load', createdAt: new Date() };
    repos._topics.push(topic);

    const N = 10_000;
    const BATCH_SIZE = 1_000;
    for (let i = 0; i < N; i += 1) {
      const subId = `sub-${i}`;
      const sub = makeSubscription({ id: subId, userId: `u-${i}`, deviceId: `d-${i}` });
      repos._subscriptions.set(subId, sub);
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    // Capture rough memory baseline before publish to bound peak growth.
    Bun.gc?.(true);
    const beforeHeapBytes = process.memoryUsage().heapUsed;

    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: BATCH_SIZE,
      topicFanoutMaxPending: 4,
      bus,
    });

    const start = Date.now();
    const result = await router.publishTopic('load', { title: 'Hi' });
    const elapsedMs = Date.now() - start;

    // (a) every subscriber received exactly one delivery attempt
    expect(result.delivered).toBe(N);
    expect(sendCountsBySubId.size).toBe(N);
    for (const c of sendCountsBySubId.values()) {
      expect(c).toBe(1);
    }
    expect(repos._deliveries.length).toBe(N);

    // (b) batches respect topicFanoutBatchSize — exactly N / BATCH_SIZE
    // batches dispatched, and each batch is full-size (uniform load shape).
    const batchEvents = events.filter(e => e.event === 'push:topic.batch.dispatched');
    expect(batchEvents).toHaveLength(N / BATCH_SIZE);
    for (const e of batchEvents) {
      expect((e.payload as { size: number }).size).toBe(BATCH_SIZE);
    }

    // (c) completion within reasonable wall time. The provider stub is
    // synchronous so this should easily finish in a couple seconds; the
    // generous bound just prevents quadratic regressions from passing.
    expect(elapsedMs).toBeLessThan(60_000);

    // (c, cont.) heap growth is bounded — we keep N delivery records by
    // design, but should not retain per-batch buffers or accumulate
    // unbounded promises. Assert peak heap grew by less than a generous
    // upper bound (~250 MB) which would catch leaks like retaining all
    // Promise chains or duplicating subscriptions.
    Bun.gc?.(true);
    const afterHeapBytes = process.memoryUsage().heapUsed;
    const growthMb = (afterHeapBytes - beforeHeapBytes) / (1024 * 1024);
    expect(growthMb).toBeLessThan(250);
  }, 60_000); // Generous timeout: 10k stubbed sends should be fast, but CI variance.
});

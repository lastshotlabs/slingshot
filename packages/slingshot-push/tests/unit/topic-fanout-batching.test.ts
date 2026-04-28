/**
 * Verify topic fan-out is dispatched in batches of `topicFanoutBatchSize` and
 * that a 5,000-subscription topic is split into 5 batches of 1,000.
 */
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { PushProvider } from '../../src/providers/provider';
import { type PushRouterRepos, createPushRouter } from '../../src/router';
import type {
  PushDeliveryRecord,
  PushMessage,
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
  _subscriptions: PushSubscriptionRecord[];
  _topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }>;
  _memberships: PushTopicMembershipRecord[];
  _deliveries: PushDeliveryRecord[];
} {
  const subscriptions: PushSubscriptionRecord[] = [];
  const topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }> = [];
  const memberships: PushTopicMembershipRecord[] = [];
  const deliveries: PushDeliveryRecord[] = [];

  return {
    _subscriptions: subscriptions,
    _topics: topics,
    _memberships: memberships,
    _deliveries: deliveries,

    subscriptions: {
      create: async () => subscriptions[0]!,
      getById: async id => subscriptions.find(s => s.id === id) ?? null,
      delete: async () => true,
      listByUserId: async () => ({ items: subscriptions }),
      findByDevice: async () => null,
      touchLastSeen: async () => subscriptions[0]!,
      upsertByDevice: async () => subscriptions[0]!,
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

function createMockProvider(
  sendImpl: (
    sub: PushSubscriptionRecord,
    message: PushMessage,
  ) => Promise<{ ok: boolean; reason?: string }>,
): PushProvider {
  return { platform: 'web', send: sendImpl as PushProvider['send'] };
}

beforeEach(() => {
  idCounter = 0;
});

describe('Topic fan-out batching', () => {
  test('5000-subscription topic is dispatched in 5 batches of 1000', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true }));

    const topic = { id: 'topic-x', tenantId: '', name: 't', createdAt: new Date() };
    repos._topics.push(topic);

    const N = 5000;
    for (let i = 0; i < N; i += 1) {
      const subId = `sub-${i}`;
      repos._subscriptions.push(makeSubscription({ id: subId, userId: `u-${i}` }));
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: 1000,
    });

    const result = await router.publishTopic('t', { title: 'Hi' });
    expect(result.delivered).toBe(N);

    // Exactly 5 batch info logs.
    const batchLogs = infoSpy.mock.calls.filter(
      c => String(c[0]).includes('batch') && String(c[0]).includes('dispatched'),
    );
    expect(batchLogs).toHaveLength(5);
    // Each log states "1/5", "2/5", ... "5/5"
    for (let b = 1; b <= 5; b += 1) {
      const found = batchLogs.find(c => String(c[0]).includes(`batch ${b}/5`));
      expect(found).toBeDefined();
      expect(String(found?.[0])).toContain('size=1000');
    }
    infoSpy.mockRestore();
  });

  test('emits push:topic.batch.dispatched event for each batch', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true }));
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    };

    const topic = { id: 'topic-y', tenantId: '', name: 'y', createdAt: new Date() };
    repos._topics.push(topic);
    const N = 2500;
    for (let i = 0; i < N; i += 1) {
      const subId = `s-${i}`;
      repos._subscriptions.push(makeSubscription({ id: subId, userId: `u-${i}` }));
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
      topicFanoutBatchSize: 1000,
      bus,
    });
    await router.publishTopic('y', { title: 'Hi' });

    const batchEvents = events.filter(e => e.event === 'push:topic.batch.dispatched');
    expect(batchEvents).toHaveLength(3);
    // 1000 + 1000 + 500
    const sizes = batchEvents.map(e => (e.payload as { size: number }).size).sort((a, b) => a - b);
    expect(sizes).toEqual([500, 1000, 1000]);
  });

  test('respects topicFanoutMaxPending back-pressure (does not exceed limit)', async () => {
    const repos = createFakeRepos();

    // Track concurrent in-flight batches by counting concurrent provider.send + waiting.
    let activeBatchCount = 0;
    let peakActive = 0;

    // Each membership corresponds to one subscription. We slow down getById per
    // batch so we can observe peak in-flight concurrency.
    const provider = createMockProvider(async () => ({ ok: true }));

    const topic = { id: 'topic-z', tenantId: '', name: 'z', createdAt: new Date() };
    repos._topics.push(topic);
    const N = 600;
    for (let i = 0; i < N; i += 1) {
      const subId = `s-${i}`;
      repos._subscriptions.push(makeSubscription({ id: subId, userId: `u-${i}` }));
      repos._memberships.push({
        id: `m-${i}`,
        topicId: topic.id,
        subscriptionId: subId,
        userId: `u-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    // Wrap getById so each batch's dispatch holds active for a tick.
    const original = repos.subscriptions.getById;
    let firstInBatchPerId = new Set<string>();
    repos.subscriptions.getById = async (id: string) => {
      if (!firstInBatchPerId.has(id)) {
        firstInBatchPerId.add(id);
        activeBatchCount += 1;
        peakActive = Math.max(peakActive, activeBatchCount);
        await new Promise<void>(r => setTimeout(r, 1));
        activeBatchCount -= 1;
      }
      return original.call(repos.subscriptions, id);
    };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      topicFanoutBatchSize: 100,
      topicFanoutMaxPending: 2,
    });

    await router.publishTopic('z', { title: 'Hi' });

    // peak in-flight per-subscription resolutions should not exceed
    // topicFanoutMaxPending * topicFanoutBatchSize (= 200) — proves
    // batches were not all scheduled at once.
    expect(peakActive).toBeLessThanOrEqual(200);
    // and we DID dispatch all 6 batches (600 / 100)
    // (just sanity-checking the count is right)
    expect(repos._deliveries.length).toBe(N);
  });
});

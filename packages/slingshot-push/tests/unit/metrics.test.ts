/**
 * Unified metrics emitter integration tests for slingshot-push router.
 *
 * Wires an in-process MetricsEmitter into the router and asserts that
 * per-send counters, durations, subscription-cleanup counters, topic-fanout
 * counters, and provider circuit-breaker / consecutive-failure gauges land
 * in the snapshot after a representative workload.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import type { PushProvider, PushProviderHealth } from '../../src/providers/provider';
import { createPushRouter } from '../../src/router';
import type { PushRouterRepos } from '../../src/router';
import type {
  PushDeliveryRecord,
  PushMessage,
  PushSubscriptionRecord,
  PushTopicMembershipRecord,
} from '../../src/types/models';

let idCounter = 0;
function nextId(): string {
  return `m-${++idCounter}`;
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
      keys: { p256dh: 'key', auth: 'auth' },
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
      create: async input => {
        const raw = { ...(input as Record<string, unknown>), id: nextId() };
        const sub = raw as unknown as PushSubscriptionRecord;
        subscriptions.push(sub);
        return sub;
      },
      getById: async id => subscriptions.find(s => s.id === id) ?? null,
      delete: async id => {
        const idx = subscriptions.findIndex(s => s.id === id);
        if (idx === -1) return false;
        subscriptions.splice(idx, 1);
        return true;
      },
      listByUserId: async ({ userId, tenantId }) => ({
        items: subscriptions.filter(s => s.userId === userId && s.tenantId === tenantId),
      }),
      findByDevice: async ({ userId, tenantId, deviceId }) =>
        subscriptions.find(
          s => s.userId === userId && s.tenantId === tenantId && s.deviceId === deviceId,
        ) ?? null,
      touchLastSeen: async ({ id }, input) => {
        const sub = subscriptions.find(s => s.id === id);
        if (!sub) throw new Error('not found');
        Object.assign(sub, input);
        return sub;
      },
      upsertByDevice: async params => {
        const p = params as Record<string, unknown>;
        const rawSub = { ...p, id: nextId() };
        const sub = rawSub as unknown as PushSubscriptionRecord;
        subscriptions.push(sub);
        return sub;
      },
    },
    topics: {
      ensureByName: async ({ tenantId, name }) => {
        let topic = topics.find(t => t.tenantId === tenantId && t.name === name);
        if (!topic) {
          topic = { id: nextId(), tenantId, name, createdAt: new Date() };
          topics.push(topic);
        }
        return topic;
      },
      findByName: async ({ tenantId, name }) =>
        topics.find(t => t.tenantId === tenantId && t.name === name) ?? null,
    },
    topicMemberships: {
      ensureMembership: async params => {
        const p = params as Record<string, unknown>;
        const rawM = { ...p, id: nextId(), createdAt: new Date() };
        const m = rawM as unknown as PushTopicMembershipRecord;
        memberships.push(m);
        return m;
      },
      listByTopic: async ({ topicId }) => ({
        items: memberships.filter(m => m.topicId === topicId),
      }),
      removeByTopicAndSub: async () => ({ count: 0 }),
      removeBySubscription: async ({ subscriptionId }) => {
        const before = memberships.length;
        for (let i = memberships.length - 1; i >= 0; i--) {
          if (memberships[i]!.subscriptionId === subscriptionId) memberships.splice(i, 1);
        }
        return { count: before - memberships.length };
      },
    },
    deliveries: {
      create: async input => {
        const delivery: PushDeliveryRecord = {
          id: nextId(),
          tenantId: '',
          userId: (input as Record<string, unknown>)['userId'] as string,
          subscriptionId: (input as Record<string, unknown>)['subscriptionId'] as string,
          platform: (input as Record<string, unknown>)['platform'] as 'web',
          notificationId: undefined,
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
        Object.assign(d, {
          status: 'sent',
          sentAt: new Date(),
          providerMessageId: providerMessageId ?? null,
        });
        return d;
      },
      markDelivered: async ({ id }) => {
        const d = deliveries.find(x => x.id === id);
        if (!d) return null;
        Object.assign(d, { status: 'delivered', deliveredAt: new Date() });
        return d;
      },
      markFailed: async ({ id, failureReason }) => {
        const d = deliveries.find(x => x.id === id);
        if (!d) return null;
        Object.assign(d, { status: 'failed', failureReason });
        return d;
      },
      incrementAttempts: async (id, by = 1) => {
        const d = deliveries.find(x => x.id === id);
        if (d) Object.assign(d, { attempts: d.attempts + by });
        return d ?? {};
      },
    },
  };
}

function createMockProvider(
  sendImpl: (sub: PushSubscriptionRecord, message: PushMessage) => Promise<unknown>,
  health?: PushProviderHealth,
): PushProvider {
  return {
    platform: 'web',
    send: sendImpl as PushProvider['send'],
    ...(health ? { getHealth: () => health } : {}),
  };
}

beforeEach(() => {
  idCounter = 0;
});

describe('createPushRouter — metrics emitter', () => {
  test('records push.send.count success + push.send.duration on successful delivery', async () => {
    const metrics = createInProcessMetricsEmitter();
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true, providerMessageId: 'pm-1' }));

    repos._subscriptions.push(makeSubscription({ userId: 'user-1' }));

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      metrics,
    });
    const result = await router.sendToUser('user-1', { title: 'hello' });
    expect(result.delivered).toBe(1);

    const snap = metrics.snapshot();
    const ok = snap.counters.find(
      c =>
        c.name === 'push.send.count' &&
        c.labels.provider === 'web' &&
        c.labels.result === 'success',
    );
    expect(ok?.value).toBe(1);
    const duration = snap.timings.find(
      t => t.name === 'push.send.duration' && t.labels.provider === 'web',
    );
    expect(duration?.count).toBeGreaterThanOrEqual(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);
  });

  test('records failure-result label and subscription cleanup on invalidToken', async () => {
    const metrics = createInProcessMetricsEmitter();
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({
      ok: false,
      reason: 'invalidToken',
      error: 'Unregistered',
    }));

    repos._subscriptions.push(makeSubscription({ userId: 'user-1' }));

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2 },
      metrics,
    });
    await router.sendToUser('user-1', { title: 'x' });

    const snap = metrics.snapshot();
    const fail = snap.counters.find(
      c =>
        c.name === 'push.send.count' &&
        c.labels.provider === 'web' &&
        c.labels.result === 'invalidToken',
    );
    expect(fail?.value).toBeGreaterThanOrEqual(1);

    const cleanup = snap.counters.find(
      c =>
        c.name === 'push.subscription.cleanup.count' &&
        c.labels.provider === 'web' &&
        c.labels.reason === 'invalidToken',
    );
    expect(cleanup?.value).toBeGreaterThanOrEqual(1);
  });

  test('records push.topic.fanout.count when publishTopic enumerates members', async () => {
    const metrics = createInProcessMetricsEmitter();
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true, providerMessageId: 'pm' }));

    const sub1 = makeSubscription({ userId: 'user-1', id: 'sub-a' });
    const sub2 = makeSubscription({ userId: 'user-2', id: 'sub-b', deviceId: 'd2' });
    repos._subscriptions.push(sub1, sub2);
    const topic = await repos.topics.ensureByName({ tenantId: '', name: 'news' });
    await repos.topicMemberships.ensureMembership({
      topicId: topic.id,
      subscriptionId: sub1.id,
      userId: sub1.userId,
      tenantId: '',
    });
    await repos.topicMemberships.ensureMembership({
      topicId: topic.id,
      subscriptionId: sub2.id,
      userId: sub2.userId,
      tenantId: '',
    });

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      metrics,
    });
    await router.publishTopic('news', { title: 'tap' });

    const snap = metrics.snapshot();
    const fanout = snap.counters.find(
      c => c.name === 'push.topic.fanout.count' && c.labels.topic === 'news',
    );
    expect(fanout?.value).toBe(2);
  });

  test('publishes circuitBreaker.state + consecutiveFailures gauges from provider health', async () => {
    const metrics = createInProcessMetricsEmitter();
    const repos = createFakeRepos();
    let breaker: PushProviderHealth['circuitState'] = 'closed';
    let failures = 0;
    const provider = createMockProvider(
      async () => {
        failures += 3;
        breaker = 'open';
        return { ok: true, providerMessageId: 'p' };
      },
      // The health closure is reread each call below.
    );
    (provider as PushProvider).getHealth = () => ({
      consecutiveFailures: failures,
      circuitState: breaker,
      lastFailureAt: null,
    });

    repos._subscriptions.push(makeSubscription({ userId: 'user-1' }));

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      metrics,
    });
    await router.sendToUser('user-1', { title: 't' });

    const snap = metrics.snapshot();
    const state = snap.gauges.find(
      g => g.name === 'push.circuitBreaker.state' && g.labels.provider === 'web',
    );
    expect(state?.value).toBe(1);
    const consecutive = snap.gauges.find(
      g => g.name === 'push.consecutiveFailures' && g.labels.provider === 'web',
    );
    expect(consecutive?.value).toBeGreaterThanOrEqual(3);
  });
});

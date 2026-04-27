/**
 * Unit tests for createPushRouter.
 *
 * Tests routing by platform, fan-out, invalid-token cleanup, retry backoff,
 * topic publish, and unknown-platform skip behavior.
 */
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { PushProvider } from '../../src/providers/provider';
import { createPushRouter } from '../../src/router';
import type { PushRouterRepos } from '../../src/router';
import type {
  PushDeliveryRecord,
  PushMessage,
  PushSubscriptionRecord,
  PushTopicMembershipRecord,
} from '../../src/types/models';

// ---------------------------------------------------------------------------
// In-memory repo fakes
// ---------------------------------------------------------------------------

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
        const raw = {
          ...(input as Record<string, unknown>),
          id: nextId(),
        };
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
        const existing = subscriptions.find(
          s =>
            s.userId === p['userId'] &&
            s.tenantId === p['tenantId'] &&
            s.deviceId === p['deviceId'],
        );
        if (existing) {
          Object.assign(existing, p);
          return existing;
        }
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
        let m = memberships.find(
          x => x.topicId === p['topicId'] && x.subscriptionId === p['subscriptionId'],
        );
        if (!m) {
          const rawM = { ...p, id: nextId(), createdAt: new Date() };
          m = rawM as unknown as PushTopicMembershipRecord;
          memberships.push(m);
        }
        return m;
      },
      listByTopic: async ({ topicId }) => ({
        items: memberships.filter(m => m.topicId === topicId),
      }),
      removeByTopicAndSub: async ({ topicId, subscriptionId }) => {
        const before = memberships.length;
        const idx = memberships.findIndex(
          m => m.topicId === topicId && m.subscriptionId === subscriptionId,
        );
        if (idx !== -1) memberships.splice(idx, 1);
        return { count: before - memberships.length };
      },
      removeBySubscription: async ({ subscriptionId }) => {
        const before = memberships.length;
        const indices: number[] = [];
        for (let i = memberships.length - 1; i >= 0; i--) {
          if (memberships[i]!.subscriptionId === subscriptionId) indices.push(i);
        }
        for (const i of indices) memberships.splice(i, 1);
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
          notificationId: (input as Record<string, unknown>)['notificationId'] as
            | string
            | undefined,
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
        if (d) {
          Object.assign(d, { attempts: d.attempts + by });
        }
        return d ?? {};
      },
    },
  };
}

function createMockProvider(
  sendImpl: (
    sub: PushSubscriptionRecord,
    message: PushMessage,
  ) => Promise<{
    ok: boolean;
    reason?: string;
    retryAfterMs?: number;
    error?: string;
    providerMessageId?: string;
  }>,
): PushProvider {
  return {
    platform: 'web',
    send: sendImpl as PushProvider['send'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  idCounter = 0;
});

describe('createPushRouter — sendToUser', () => {
  test('sends to all subscriptions for a user', async () => {
    const repos = createFakeRepos();
    const sendCalls: PushSubscriptionRecord[] = [];
    const provider = createMockProvider(async sub => {
      sendCalls.push(sub);
      return { ok: true };
    });

    repos._subscriptions.push(
      makeSubscription({ userId: 'user-1', id: 'sub-1' }),
      makeSubscription({ userId: 'user-1', id: 'sub-2', deviceId: 'device-2' }),
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    const count = await router.sendToUser('user-1', { title: 'Hello' });

    expect(count).toBe(2);
    expect(sendCalls).toHaveLength(2);
  });

  test('skips subscriptions whose platform has no provider', async () => {
    const repos = createFakeRepos();
    const sendCalls: unknown[] = [];
    const provider = createMockProvider(async () => {
      sendCalls.push(true);
      return { ok: true };
    });

    repos._subscriptions.push(
      makeSubscription({ platform: 'web' }),
      makeSubscription({
        platform: 'ios',
        id: 'sub-ios',
        platformData: {
          platform: 'ios',
          deviceToken: 'tok',
          bundleId: 'com.test',
          environment: 'sandbox',
        },
      }),
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    // Only the 'web' sub was sent — 'ios' has no provider
    expect(sendCalls).toHaveLength(1);
  });

  test('injects __slingshotDeliveryId into message data', async () => {
    const repos = createFakeRepos();
    let sentData: Record<string, unknown> | undefined;
    const provider = createMockProvider(async (_sub: PushSubscriptionRecord, msg: PushMessage) => {
      sentData = (msg as { data?: Record<string, unknown> }).data;
      return { ok: true };
    });
    // Provide the msg arg to the mock
    provider.send = async (_sub, msg) => {
      sentData = msg.data;
      return { ok: true };
    };

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello', data: { extra: 'val' } });

    expect(sentData).toBeDefined();
    expect(typeof sentData!['__slingshotDeliveryId']).toBe('string');
    expect(sentData!['extra']).toBe('val');
  });

  test('marks delivery as sent on success', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true, providerMessageId: 'msg-123' }));

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    const delivery = repos._deliveries[0]!;
    expect(delivery.status).toBe('sent');
    expect(delivery.providerMessageId).toBe('msg-123');
  });
});

describe('createPushRouter — invalid token cleanup', () => {
  test('deletes subscription on invalidToken result', async () => {
    const repos = createFakeRepos();
    const emitted: string[] = [];
    const bus = {
      emit: (evt: string) => {
        emitted.push(evt);
      },
    };
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'invalidToken' as const,
      error: 'expired',
    }));

    const sub = makeSubscription({ id: 'sub-1' });
    repos._subscriptions.push(sub);
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      bus,
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._subscriptions).toHaveLength(0);
    expect(emitted).toContain('push:subscription.invalidated');
    expect(emitted).toContain('push:delivery.failed');
  });

  test('removes all topic memberships for invalidated subscription', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'invalidToken' as const,
      error: 'gone',
    }));

    const sub = makeSubscription({ id: 'sub-1' });
    repos._subscriptions.push(sub);
    repos._topics.push({ id: 'topic-1', tenantId: '', name: 'general', createdAt: new Date() });
    repos._memberships.push({
      id: 'm-1',
      topicId: 'topic-1',
      subscriptionId: 'sub-1',
      userId: 'user-1',
      tenantId: '',
      createdAt: new Date(),
    });

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._memberships).toHaveLength(0);
  });

  test('marks delivery failed on invalidToken', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'invalidToken' as const,
      error: 'expired',
    }));

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._deliveries[0]!.status).toBe('failed');
    expect(repos._deliveries[0]!.failureReason).toBe('invalidToken');
  });
});

describe('createPushRouter — payloadTooLarge', () => {
  test('marks delivery failed and emits payload_too_large event', async () => {
    const repos = createFakeRepos();
    const emitted: string[] = [];
    const bus = {
      emit: (evt: string) => {
        emitted.push(evt);
      },
    };
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'payloadTooLarge' as const,
      error: 'too big',
    }));

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      bus,
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._deliveries[0]!.failureReason).toBe('payloadTooLarge');
    expect(emitted).toContain('push:message.payload_too_large');
  });

  test('subscription is NOT deleted on payloadTooLarge', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'payloadTooLarge' as const,
      error: 'too big',
    }));

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._subscriptions).toHaveLength(1);
  });
});

describe('createPushRouter — retry behavior', () => {
  test('retries up to maxAttempts on transient failure then marks failed', async () => {
    const repos = createFakeRepos();
    let callCount = 0;
    const provider = createMockProvider(async () => {
      callCount += 1;
      return { ok: false as const, reason: 'transient' as const, error: 'flaky' };
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 3, initialDelayMs: 0 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(callCount).toBe(3);
    expect(repos._deliveries[0]!.failureReason).toBe('transient');
  });

  test('succeeds on second attempt after transient failure', async () => {
    const repos = createFakeRepos();
    let callCount = 0;
    const provider = createMockProvider(async () => {
      callCount += 1;
      if (callCount === 1)
        return { ok: false as const, reason: 'transient' as const, error: 'flaky' };
      return { ok: true };
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 3, initialDelayMs: 0 },
    });
    const count = await router.sendToUser('user-1', { title: 'Hello' });

    expect(callCount).toBe(2);
    expect(count).toBe(1);
    expect(repos._deliveries[0]!.status).toBe('sent');
  });

  test('increments attempts counter on each try', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({
      ok: false as const,
      reason: 'transient' as const,
      error: 'err',
    }));

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._deliveries[0]!.attempts).toBe(2);
  });
});

describe('createPushRouter — sendToUsers', () => {
  test('sends to multiple unique users without duplicating fan-out', async () => {
    const repos = createFakeRepos();
    const sentUserIds: string[] = [];
    const provider = createMockProvider(async sub => {
      sentUserIds.push(sub.userId);
      return { ok: true };
    });
    provider.send = async sub => {
      sentUserIds.push(sub.userId);
      return { ok: true };
    };

    repos._subscriptions.push(
      makeSubscription({ userId: 'user-1', id: 'sub-1' }),
      makeSubscription({ userId: 'user-2', id: 'sub-2', deviceId: 'd2' }),
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    const count = await router.sendToUsers(['user-1', 'user-2'], { title: 'Broadcast' });

    expect(count).toBe(2);
  });

  test('works when sendToUsers is destructured from the router', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true }));
    provider.send = async () => ({ ok: true });

    repos._subscriptions.push(
      makeSubscription({ userId: 'user-1', id: 'sub-1' }),
      makeSubscription({ userId: 'user-2', id: 'sub-2', deviceId: 'd2' }),
    );

    const { sendToUsers } = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });

    const count = await sendToUsers(['user-1', 'user-2'], { title: 'Broadcast' });
    expect(count).toBe(2);
  });

  test('deduplicates user IDs', async () => {
    const repos = createFakeRepos();
    const calls: string[] = [];
    const provider = createMockProvider(async sub => {
      calls.push(sub.userId);
      return { ok: true };
    });
    provider.send = async sub => {
      calls.push(sub.userId);
      return { ok: true };
    };

    repos._subscriptions.push(makeSubscription({ userId: 'user-1' }));
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    await router.sendToUsers(['user-1', 'user-1'], { title: 'x' });

    // user-1 sent exactly once
    expect(calls.filter(u => u === 'user-1')).toHaveLength(1);
  });
});

describe('createPushRouter — publishTopic', () => {
  test('reaches all topic members', async () => {
    const repos = createFakeRepos();
    const sentIds: string[] = [];
    const provider = createMockProvider(async sub => {
      sentIds.push(sub.id);
      return { ok: true };
    });
    provider.send = async sub => {
      sentIds.push(sub.id);
      return { ok: true };
    };

    // Two users subscribed to topic
    const sub1 = makeSubscription({ id: 'sub-a', userId: 'user-1' });
    const sub2 = makeSubscription({ id: 'sub-b', userId: 'user-2', deviceId: 'd2' });
    repos._subscriptions.push(sub1, sub2);

    const topic = { id: 'topic-1', tenantId: '', name: 'general', createdAt: new Date() };
    repos._topics.push(topic);
    repos._memberships.push(
      {
        id: 'm-1',
        topicId: 'topic-1',
        subscriptionId: 'sub-a',
        userId: 'user-1',
        tenantId: '',
        createdAt: new Date(),
      },
      {
        id: 'm-2',
        topicId: 'topic-1',
        subscriptionId: 'sub-b',
        userId: 'user-2',
        tenantId: '',
        createdAt: new Date(),
      },
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    const count = await router.publishTopic('general', { title: 'Announcement' });

    expect(count).toBe(2);
    expect(sentIds).toContain('sub-a');
    expect(sentIds).toContain('sub-b');
  });

  test('returns 0 when topic does not exist', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true }));
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });
    const count = await router.publishTopic('nonexistent', { title: 'x' });
    expect(count).toBe(0);
  });

  test('caps delivery at 10,000 members and warns when exceeded', async () => {
    const repos = createFakeRepos();
    const sentIds: string[] = [];
    const provider = createMockProvider(async sub => {
      sentIds.push(sub.id);
      return { ok: true };
    });

    const topic = { id: 'topic-big', tenantId: '', name: 'broadcast', createdAt: new Date() };
    repos._topics.push(topic);

    const CAP = 10_000;
    for (let i = 0; i < CAP + 5; i++) {
      const subId = `sub-${i}`;
      repos._subscriptions.push(makeSubscription({ id: subId, userId: `user-${i}` }));
      repos._memberships.push({
        id: `m-${i}`,
        topicId: 'topic-big',
        subscriptionId: subId,
        userId: `user-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });

    const count = await router.publishTopic('broadcast', { title: 'Hello' });

    expect(count).toBe(CAP);
    expect(sentIds).toHaveLength(CAP);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('10000');

    warnSpy.mockRestore();
  });
});

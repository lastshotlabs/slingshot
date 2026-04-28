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
    const result = await router.sendToUser('user-1', { title: 'Hello' });

    expect(result.delivered).toBe(2);
    expect(result.attempted).toBe(2);
    expect(result.allFailed).toBe(false);
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
    const result = await router.sendToUser('user-1', { title: 'Hello' });

    expect(callCount).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.allFailed).toBe(false);
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

  test('catches provider.send() throws and treats them as transient failures', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => {
      throw new Error('provider exploded');
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(repos._deliveries[0]!.status).toBe('failed');
    expect(repos._deliveries[0]!.failureReason).toBe('transient');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Provider threw'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  test('continues fan-out when marking one delivery fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const repos = createFakeRepos();
    let sendCount = 0;
    const provider = createMockProvider(async () => {
      sendCount += 1;
      return { ok: true };
    });
    repos._subscriptions.push(
      makeSubscription({ id: 'sub-fail', userId: 'user-1', deviceId: 'device-fail' }),
      makeSubscription({ id: 'sub-ok', userId: 'user-1', deviceId: 'device-ok' }),
    );

    let markSentCalls = 0;
    const originalMarkSent = repos.deliveries.markSent;
    repos.deliveries.markSent = async params => {
      markSentCalls += 1;
      if (markSentCalls === 1) throw new Error('delivery repo down');
      return originalMarkSent(params);
    };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });
    const result = await router.sendToUser('user-1', { title: 'Hello' });

    expect(result.delivered).toBe(1);
    expect(sendCount).toBe(2);
    expect(repos._deliveries[0]!.status).toBe('failed');
    expect(repos._deliveries[0]!.failureReason).toBe('repositoryFailure');
    expect(repos._deliveries[1]!.status).toBe('sent');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Repository failure during fan-out'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  test('respects retryAfterMs hint from provider instead of default backoff', async () => {
    const repos = createFakeRepos();
    let callCount = 0;
    const callTimestamps: number[] = [];
    const provider = createMockProvider(async () => {
      callCount += 1;
      callTimestamps.push(Date.now());
      if (callCount === 1) {
        return {
          ok: false as const,
          reason: 'transient' as const,
          retryAfterMs: 10,
          error: 'rate-limited',
        };
      }
      return { ok: true };
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 100_000 },
    });
    const start = Date.now();
    const result = await router.sendToUser('user-1', { title: 'Hello' });

    expect(result.delivered).toBe(1);
    expect(callCount).toBe(2);
    // retryAfterMs: 10 was used, not initialDelayMs: 100_000
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test('waits approximately the provider-supplied retryAfterMs between attempts', async () => {
    const repos = createFakeRepos();
    let callCount = 0;
    const callTimestamps: number[] = [];
    const provider = createMockProvider(async () => {
      callCount += 1;
      callTimestamps.push(Date.now());
      if (callCount === 1) {
        return {
          ok: false as const,
          reason: 'rateLimited' as const,
          retryAfterMs: 200, // measurable but fast enough for unit test
          error: 'slow down',
        };
      }
      return { ok: true };
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      // Exponential would be 50ms — much smaller than retryAfterMs 200ms,
      // so observing >= ~180ms confirms the router used the provider hint.
      retries: { maxAttempts: 2, initialDelayMs: 50 },
    });
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(callCount).toBe(2);
    const gap = callTimestamps[1]! - callTimestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(150);
    expect(gap).toBeLessThan(2_000);
  });

  test('clamps retryAfterMs to retries.maxDelayMs', async () => {
    const repos = createFakeRepos();
    let callCount = 0;
    const callTimestamps: number[] = [];
    const provider = createMockProvider(async () => {
      callCount += 1;
      callTimestamps.push(Date.now());
      if (callCount === 1) {
        return {
          ok: false as const,
          reason: 'rateLimited' as const,
          retryAfterMs: 60_000, // provider asks for 60s
          error: 'slow down',
        };
      }
      return { ok: true };
    });

    repos._subscriptions.push(makeSubscription());
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 50 }, // clamp to 50ms
    });
    const start = Date.now();
    await router.sendToUser('user-1', { title: 'Hello' });

    expect(callCount).toBe(2);
    // Because the 60_000ms hint was clamped to 50ms, total wall time is tiny.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test('"permanent" reason marks failed without retrying and keeps subscription', async () => {
    const repos = createFakeRepos();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    };
    let callCount = 0;
    const provider = createMockProvider(async () => {
      callCount += 1;
      return {
        ok: false as const,
        reason: 'permanent' as const,
        error: 'invalid service-account credentials',
      };
    });

    const sub = makeSubscription({ id: 'sub-perm' });
    repos._subscriptions.push(sub);
    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 5, initialDelayMs: 0 }, // permanent should short-circuit retries
      bus,
    });
    const result = await router.sendToUser('user-1', { title: 'Hello' });

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(true);
    // Only one provider call — no retries on permanent.
    expect(callCount).toBe(1);
    // Delivery is marked failed with reason "permanent".
    expect(repos._deliveries[0]!.status).toBe('failed');
    expect(repos._deliveries[0]!.failureReason).toBe('permanent');
    // Subscription is NOT deleted — permanent is a provider-config issue, not subscription rot.
    expect(repos._subscriptions).toHaveLength(1);
    // Emits push:delivery.failed with reason permanent (and the error).
    const failedEvent = emitted.find(e => e.event === 'push:delivery.failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { reason: string }).reason).toBe('permanent');
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
    const result = await router.sendToUsers(['user-1', 'user-2'], { title: 'Broadcast' });

    expect(result.delivered).toBe(2);
    expect(result.allFailed).toBe(false);
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

    const result = await sendToUsers(['user-1', 'user-2'], { title: 'Broadcast' });
    expect(result.delivered).toBe(2);
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
    const result = await router.publishTopic('general', { title: 'Announcement' });

    expect(result.delivered).toBe(2);
    expect(result.allFailed).toBe(false);
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
    const result = await router.publishTopic('nonexistent', { title: 'x' });
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(0);
    // Missing topic is not "all failed" — there was nothing to attempt.
    expect(result.allFailed).toBe(false);
  });

  test('delivers to all members and warns when topic fan-out is large', async () => {
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

    const result = await router.publishTopic('broadcast', { title: 'Hello' });

    expect(result.delivered).toBe(CAP + 5);
    expect(sentIds).toHaveLength(CAP + 5);
    const capWarning = warnSpy.mock.calls.find(c => String(c[0]).includes('10005'));
    expect(capWarning).toBeDefined();
    expect(String(capWarning?.[0])).toContain('slingshot-push');

    warnSpy.mockRestore();
  });

  test('publishTopic fetches all member subscriptions in parallel (no serial N+1)', async () => {
    const repos = createFakeRepos();
    const provider = createMockProvider(async () => ({ ok: true }));
    const topic = { id: 'topic-par', tenantId: '', name: 'parallel', createdAt: new Date() };
    repos._topics.push(topic);

    for (let i = 0; i < 5; i++) {
      const subId = `par-sub-${i}`;
      repos._subscriptions.push(makeSubscription({ id: subId, userId: `par-user-${i}` }));
      repos._memberships.push({
        id: `par-m-${i}`,
        topicId: 'topic-par',
        subscriptionId: subId,
        userId: `par-user-${i}`,
        tenantId: '',
        createdAt: new Date(),
      });
    }

    // Track peak concurrency: with Promise.all all 5 increment before any yield
    let activeCalls = 0;
    let peakConcurrency = 0;
    const originalGetById = repos.subscriptions.getById.bind(repos.subscriptions);
    repos.subscriptions.getById = async (id: string) => {
      activeCalls++;
      peakConcurrency = Math.max(peakConcurrency, activeCalls);
      await Promise.resolve(); // one microtask yield — serial would cap at 1
      activeCalls--;
      return originalGetById(id);
    };

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
    });

    await router.publishTopic('parallel', { title: 'Parallel' });

    // All 5 getById calls must have been in-flight at the same time
    expect(peakConcurrency).toBe(5);
  });
});

describe('createPushRouter — provider timeout', () => {
  test('treats a provider that hangs past providerTimeoutMs as transient failure', async () => {
    const repos = createFakeRepos();
    repos._subscriptions.push(makeSubscription({ id: 'timeout-sub', userId: 'user-timeout' }));

    const provider = createMockProvider(
      () => new Promise<never>(() => {}), // never resolves
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      providerTimeoutMs: 1, // 1ms — ensures immediate timeout in test
    });

    // Should not hang; router should resolve after timeout
    const result = await router.sendToUser('user-timeout', { title: 'Ping' });

    // Delivery was attempted but failed (transient), so delivered is 0 and allFailed is true
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(true);

    // Delivery record should be marked failed
    const delivery = repos._deliveries.find(d => d.subscriptionId === 'timeout-sub');
    expect(delivery?.status).toBe('failed');
    expect(delivery?.failureReason).toBe('transient');
  });

  test('successful send under timeout limit completes normally', async () => {
    const repos = createFakeRepos();
    repos._subscriptions.push(makeSubscription({ id: 'fast-sub', userId: 'user-fast' }));

    const provider = createMockProvider(async () => ({ ok: true }));

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1 },
      providerTimeoutMs: 5_000,
    });

    const result = await router.sendToUser('user-fast', { title: 'Fast' });
    expect(result.delivered).toBe(1);
  });
});

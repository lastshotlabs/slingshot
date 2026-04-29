/**
 * All-providers-fail contract for push router delivery.
 *
 * The router's documented contract states that it does NOT throw when every
 * provider fails — instead the caller observes `allFailed: true` on the
 * returned `PushSendResultSummary` and per-delivery failures via the event
 * bus. This file tests that contract through sendToUser and sendToUsers,
 * plus provider timeout handling (which surfaces as transient failure).
 *
 * Contract assertions:
 *   (a) When all providers fail, `allFailed` is true, `delivered` is 0,
 *       `attempted` is N, and one `push:delivery.failed` event is emitted
 *       per subscription. No exceptions are thrown.
 *   (b) When some fail but at least one succeeds, `allFailed` is false.
 *   (c) Provider timeouts are caught, treated as transient failure, and
 *       surfaced through the same failure contract as (a).
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

function makeWebSubscription(
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
  return {
    id: nextId(),
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-web',
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

function makeIosSubscription(
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
  return {
    id: nextId(),
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-ios',
    platform: 'ios',
    platformData: {
      platform: 'ios',
      deviceToken: 'apns-token',
      bundleId: 'com.example.app',
      environment: 'production',
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

function makeAndroidSubscription(
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
  return {
    id: nextId(),
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-android',
    platform: 'android',
    platformData: {
      platform: 'android',
      registrationToken: 'fcm-token',
      packageName: 'com.example.app',
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
  _deletedSubscriptionIds: string[];
} {
  const subscriptions: PushSubscriptionRecord[] = [];
  const topics: Array<{ id: string; tenantId: string; name: string; createdAt: Date }> = [];
  const memberships: PushTopicMembershipRecord[] = [];
  const deliveries: PushDeliveryRecord[] = [];
  const deletedSubscriptionIds: string[] = [];

  return {
    _subscriptions: subscriptions,
    _topics: topics,
    _memberships: memberships,
    _deliveries: deliveries,
    _deletedSubscriptionIds: deletedSubscriptionIds,

    subscriptions: {
      create: async () => {
        throw new Error('not used');
      },
      getById: async id => subscriptions.find(s => s.id === id) ?? null,
      delete: async id => {
        deletedSubscriptionIds.push(id);
        const idx = subscriptions.findIndex(s => s.id === id);
        if (idx === -1) return false;
        subscriptions.splice(idx, 1);
        return true;
      },
      listByUserId: async ({ userId, tenantId }) => ({
        items: subscriptions.filter(s => s.userId === userId && s.tenantId === tenantId),
      }),
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
          tenantId: '',
          userId: i['userId'] as string,
          subscriptionId: i['subscriptionId'] as string,
          platform: i['platform'] as 'web' | 'ios' | 'android',
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

// ---------------------------------------------------------------------------
// 1. All providers fail — allFailed: true, events emitted, no throw
// ---------------------------------------------------------------------------
describe('all-providers-fail contract (sendToUser)', () => {
  test('all providers fail with different reasons — allFailed true', async () => {
    const repos = createFakeRepos();

    const web: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'permanent', error: 'web push backend down' }),
    };
    const apns: PushProvider = {
      platform: 'ios',
      send: async () => ({ ok: false, reason: 'invalidToken' }),
    };
    const fcm: PushProvider = {
      platform: 'android',
      send: async () => ({ ok: false, reason: 'transient' }),
    };

    repos._subscriptions.push(
      makeWebSubscription({ id: 'web-1' }),
      makeIosSubscription({ id: 'ios-1' }),
      makeAndroidSubscription({ id: 'android-1' }),
    );

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { web, ios: apns, android: fcm },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
      bus: { emit: (e, p) => events.push({ event: e, payload: p }) },
    });

    const result = await router.sendToUser('user-1', { title: 'All fail test' });

    // Core contract assertions.
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(3);
    expect(result.allFailed).toBe(true);

    // Exactly one failure event per subscription.
    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(3);
    const reasons = failedEvents.map(e => (e.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual(['invalidToken', 'permanent', 'transient']);

    // Every delivery record persisted as failed.
    expect(repos._deliveries).toHaveLength(3);
    for (const d of repos._deliveries) {
      expect(d.status).toBe('failed');
    }
  });

  test('single provider failing with transient after retry exhaustion — allFailed true', async () => {
    const repos = createFakeRepos();

    // A provider that always returns transient.
    const web: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'transient' }),
    };

    repos._subscriptions.push(
      makeWebSubscription({ id: 'web-only' }),
      makeWebSubscription({ id: 'web-only-2' }),
    );

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 3, initialDelayMs: 0 },
      bus: { emit: (e, p) => events.push({ event: e, payload: p }) },
    });

    const result = await router.sendToUser('user-1', { title: 'Transient only' });

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(2);
    expect(result.allFailed).toBe(true);

    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(2);
    for (const e of failedEvents) {
      expect((e.payload as { reason: string }).reason).toBe('transient');
    }
  });

  test('all providers fail does NOT throw — contract is observable via allFailed flag', async () => {
    const repos = createFakeRepos();

    const web: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'permanent', error: 'down' }),
    };
    repos._subscriptions.push(makeWebSubscription({ id: 'w-1' }));

    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    // The router resolves, not throws.
    await expect(
      router.sendToUser('user-1', { title: 'No throw' }),
    ).resolves.toEqual({
      delivered: 0,
      attempted: 1,
      allFailed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Some providers fail but one succeeds — allFailed: false
// ---------------------------------------------------------------------------
describe('partial provider failure — allFailed false when one succeeds', () => {
  test('one platform succeeds, two fail — allFailed false', async () => {
    const repos = createFakeRepos();

    const web: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'transient' }),
    };
    const apns: PushProvider = {
      platform: 'ios',
      send: async () => ({ ok: false, reason: 'permanent', error: 'auth' }),
    };
    const fcm: PushProvider = {
      platform: 'android',
      send: async () => ({ ok: true, providerMessageId: 'fcm-msg' }),
    };

    repos._subscriptions.push(
      makeWebSubscription({ id: 'web-1' }),
      makeIosSubscription({ id: 'ios-1' }),
      makeAndroidSubscription({ id: 'android-1' }),
    );

    const router = createPushRouter({
      providers: { web, ios: apns, android: fcm },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await router.sendToUser('user-1', { title: 'Partial success' });

    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(3);
    expect(result.allFailed).toBe(false);
  });

  test('user with mixed subs across platforms — the one with no matching provider is skipped', async () => {
    const repos = createFakeRepos();

    // Only an android provider is configured.
    const fcm: PushProvider = {
      platform: 'android',
      send: async () => ({ ok: true, providerMessageId: 'fcm-msg' }),
    };

    repos._subscriptions.push(
      // android has a provider -> attempted
      makeAndroidSubscription({ id: 'android-1' }),
      // web and ios have no provider -> skipped, not counted in attempted
      makeWebSubscription({ id: 'web-1' }),
      makeIosSubscription({ id: 'ios-1' }),
    );

    const router = createPushRouter({
      providers: { android: fcm },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await router.sendToUser('user-1', { title: 'Partial providers' });

    // Only the android sub was attempted and delivered.
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(false);
  });

  test('multiple users via sendToUsers — only one succeeds, allFailed false', async () => {
    const repos = createFakeRepos();

    // user-a has one sub that succeeds; user-b has one that fails.
    const provider: PushProvider = {
      platform: 'web',
      send: async sub => {
        if (sub.id === 'a-web-1') return { ok: true, providerMessageId: 'msg-a' };
        return { ok: false, reason: 'transient' };
      },
    };

    repos._subscriptions.push(
      makeWebSubscription({ id: 'a-web-1', userId: 'user-a' }),
      makeWebSubscription({ id: 'b-web-1', userId: 'user-b' }),
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await router.sendToUsers(['user-a', 'user-b'], { title: 'Multi-user' });

    // One delivered (user-a), one attempted but failed (user-b).
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(2);
    // At least one landed -> not all-failed.
    expect(result.allFailed).toBe(false);
  });

  test('sendToUsers — all users fail, allFailed true', async () => {
    const repos = createFakeRepos();

    const provider: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: false, reason: 'permanent', error: 'down' }),
    };

    repos._subscriptions.push(
      makeWebSubscription({ id: 'x-web-1', userId: 'user-x' }),
      makeWebSubscription({ id: 'y-web-1', userId: 'user-y' }),
    );

    const router = createPushRouter({
      providers: { web: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await router.sendToUsers(['user-x', 'user-y'], { title: 'All fail multi' });

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(2);
    expect(result.allFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Provider timeout handling
// ---------------------------------------------------------------------------
describe('provider timeout handling', () => {
  test('provider that never resolves is timed out and treated as transient', async () => {
    const repos = createFakeRepos();

    // A provider whose send never settles — the router must time it out.
    const web: PushProvider = {
      platform: 'web',
      send: async () => {
        return new Promise<never>(() => {}); // never settles
      },
    };

    repos._subscriptions.push(makeWebSubscription({ id: 'timeout-sub' }));

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      // Very short timeout so the test does not hang.
      providerTimeoutMs: 10,
      bus: { emit: (e, p) => events.push({ event: e, payload: p }) },
    });

    const result = await router.sendToUser('user-1', { title: 'Timeout test' });

    // The timed-out send should be treated as a transient failure.
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(true);

    // A delivery failed event was emitted.
    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.payload as { reason: string }).reason).toBe('transient');

    // The delivery record shows failure.
    expect(repos._deliveries).toHaveLength(1);
    expect(repos._deliveries[0]!.status).toBe('failed');
  });

  test('provider timeout does not prevent other subscriptions from being delivered', async () => {
    const repos = createFakeRepos();

    // First sub's provider hangs; second sub's provider succeeds quickly.
    const apns: PushProvider = {
      platform: 'ios',
      send: async () => {
        return new Promise<never>(() => {}); // hangs
      },
    };
    const fcm: PushProvider = {
      platform: 'android',
      send: async () => ({ ok: true, providerMessageId: 'fcm-msg' }),
    };

    repos._subscriptions.push(
      makeIosSubscription({ id: 'ios-timeout' }),
      makeAndroidSubscription({ id: 'android-fast' }),
    );

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { ios: apns, android: fcm },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      providerTimeoutMs: 10,
      bus: { emit: (e, p) => events.push({ event: e, payload: p }) },
    });

    const result = await router.sendToUser('user-1', { title: 'Mixed timeout' });

    // One delivered (android), one timed out.
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.allFailed).toBe(false);

    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.payload as { subscriptionId: string }).subscriptionId).toBe(
      'ios-timeout',
    );
  });

  test('provider timeout with retries — all retries time out, allFailed true', async () => {
    const repos = createFakeRepos();

    let attemptCount = 0;
    const web: PushProvider = {
      platform: 'web',
      send: async () => {
        attemptCount += 1;
        return new Promise<never>(() => {}); // never settles
      },
    };

    repos._subscriptions.push(makeWebSubscription({ id: 'retry-timeout' }));

    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 3, initialDelayMs: 0 },
      providerTimeoutMs: 10,
    });

    const result = await router.sendToUser('user-1', { title: 'Retry timeout' });

    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(true);

    // The delivery should show 3 attempts (each attempt timed out).
    const delivery = repos._deliveries[0]!;
    expect(delivery.attempts).toBe(3);
    expect(delivery.status).toBe('failed');
    expect(delivery.failureReason).toBe('transient');
  });

  test('per-call providerTimeoutMs override works for sendToUser', async () => {
    const repos = createFakeRepos();

    // A provider that resolves after a delay — with the default timeout it
    // would time out, but the per-call override gives enough room.
    let resolved = false;
    const web: PushProvider = {
      platform: 'web',
      send: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        resolved = true;
        return { ok: true, providerMessageId: 'late-msg' };
      },
    };

    repos._subscriptions.push(makeWebSubscription({ id: 'slow-but-ok' }));

    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      // Default timeout is very short — would time out.
      providerTimeoutMs: 5,
    });

    // Override per-call with a longer timeout.
    const result = await router.sendToUser('user-1', { title: 'Slow delivery' }, {
      providerTimeoutMs: 100,
    });

    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(false);
    expect(resolved).toBe(true);
  });

  test('per-call providerTimeoutMs override works for publishTopic batch', async () => {
    const repos = createFakeRepos();

    let resolved = false;
    const web: PushProvider = {
      platform: 'web',
      send: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        resolved = true;
        return { ok: true, providerMessageId: 'batch-msg' };
      },
    };

    repos._topics.push({ id: 'timeout-topic', tenantId: '', name: 'timeout-topic', createdAt: new Date() });
    const sub = makeWebSubscription({ id: 'topic-sub-1' });
    repos._subscriptions.push(sub);
    repos._memberships.push({
      id: 'tm-1',
      topicId: 'timeout-topic',
      subscriptionId: sub.id,
      userId: sub.userId,
      tenantId: '',
      createdAt: new Date(),
    });

    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
      providerTimeoutMs: 5, // default too short
      topicFanoutBatchSize: 50,
    });

    const result = await router.publishTopic('timeout-topic', { title: 'Batch timeout' }, {
      providerTimeoutMs: 100,
    });

    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.allFailed).toBe(false);
    expect(resolved).toBe(true);
  });
});

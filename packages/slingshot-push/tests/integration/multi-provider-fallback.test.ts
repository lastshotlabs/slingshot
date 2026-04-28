/**
 * Multi-provider routing and isolation contract.
 *
 * Real apps configure FCM + APNS + web push concurrently. The router does
 * not "fall back" between providers — each subscription is routed to the
 * provider matching its platform — but provider-level failures must remain
 * isolated to that subscription's platform without leaking into the others.
 *
 * Contract verified here:
 *   (a) FCM `permanent` failure on an android sub does NOT prevent the same
 *       user's APNS sub from being delivered. Subscription stays alive.
 *   (b) APNS `invalidToken` failure deletes the offending APNS sub and its
 *       topic memberships but leaves the user's FCM sub fully untouched.
 *   (c) When every sub fails (mixed reasons), the per-delivery failures
 *       surface via `push:delivery.failed` events and `sendToUser` returns
 *       a summary `{ delivered: 0, attempted: N, allFailed: true }`. The
 *       router does not throw — total failure is observable via the
 *       `allFailed` flag and via the bus.
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
  _memberships: PushTopicMembershipRecord[];
  _deliveries: PushDeliveryRecord[];
  _membershipRemovals: Array<{ subscriptionId: string }>;
} {
  const subscriptions: PushSubscriptionRecord[] = [];
  const memberships: PushTopicMembershipRecord[] = [];
  const deliveries: PushDeliveryRecord[] = [];
  const membershipRemovals: Array<{ subscriptionId: string }> = [];

  return {
    _subscriptions: subscriptions,
    _memberships: memberships,
    _deliveries: deliveries,
    _membershipRemovals: membershipRemovals,

    subscriptions: {
      create: async () => subscriptions[0]!,
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
      findByDevice: async () => null,
      touchLastSeen: async () => subscriptions[0]!,
      upsertByDevice: async () => subscriptions[0]!,
    },
    topics: {
      ensureByName: async ({ tenantId, name }) => ({ id: nextId(), tenantId, name }),
      findByName: async () => null,
    },
    topicMemberships: {
      ensureMembership: async () => memberships[0]!,
      listByTopic: async () => ({ items: [] }),
      removeByTopicAndSub: async () => ({ count: 0 }),
      removeBySubscription: async ({ subscriptionId }) => {
        membershipRemovals.push({ subscriptionId });
        return { count: 0 };
      },
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

describe('Multi-provider isolation — failure on one platform does not leak to others', () => {
  test('(a) FCM permanent failure on android sub leaves APNS sub deliverable', async () => {
    const repos = createFakeRepos();
    const apnsSends: string[] = [];
    const fcmSends: string[] = [];

    const apns: PushProvider = {
      platform: 'ios',
      send: async sub => {
        apnsSends.push(sub.id);
        return { ok: true, providerMessageId: 'apns-msg' };
      },
    };
    const fcm: PushProvider = {
      platform: 'android',
      send: async sub => {
        fcmSends.push(sub.id);
        return { ok: false, reason: 'permanent', error: 'invalid OAuth credentials' };
      },
    };

    const iosSub = makeIosSubscription({ id: 'ios-1' });
    const androidSub = makeAndroidSubscription({ id: 'android-1' });
    repos._subscriptions.push(iosSub, androidSub);

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { ios: apns, android: fcm },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
      bus: {
        emit: (event, payload) => {
          events.push({ event, payload });
        },
      },
    });

    const result = await router.sendToUser('user-1', { title: 'Hi' });

    // APNS sub got a successful delivery, FCM sub did not.
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(2);
    // At least one delivery succeeded, so allFailed is false.
    expect(result.allFailed).toBe(false);
    expect(apnsSends).toEqual(['ios-1']);
    expect(fcmSends).toEqual(['android-1']); // exactly one attempt — permanent stops retries
    // Permanent does NOT delete the subscription — the failure is provider-config-level.
    expect(repos._subscriptions.map(s => s.id).sort()).toEqual(['android-1', 'ios-1']);
    // No membership cleanup for the android sub.
    expect(repos._membershipRemovals).toEqual([]);
    // The bus saw a permanent failure for the FCM delivery.
    const failed = events.filter(e => e.event === 'push:delivery.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { reason: string }).reason).toBe('permanent');
  });

  test('(b) APNS invalidToken removes the APNS sub but leaves FCM sub intact', async () => {
    const repos = createFakeRepos();

    const apns: PushProvider = {
      platform: 'ios',
      send: async () => ({ ok: false, reason: 'invalidToken', error: 'BadDeviceToken' }),
    };
    const fcm: PushProvider = {
      platform: 'android',
      send: async () => ({ ok: true, providerMessageId: 'fcm-msg' }),
    };

    const iosSub = makeIosSubscription({ id: 'ios-bad' });
    const androidSub = makeAndroidSubscription({ id: 'android-good' });
    repos._subscriptions.push(iosSub, androidSub);

    const events: Array<{ event: string; payload: unknown }> = [];
    const router = createPushRouter({
      providers: { ios: apns, android: fcm },
      repos,
      retries: { maxAttempts: 2, initialDelayMs: 0 },
      bus: {
        emit: (event, payload) => {
          events.push({ event, payload });
        },
      },
    });

    const result = await router.sendToUser('user-1', { title: 'Hi' });

    // FCM sub delivered, APNS sub failed and got cleaned up.
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(2);
    // Mixed result — at least one succeeded, so not all-failed.
    expect(result.allFailed).toBe(false);
    expect(repos._subscriptions.map(s => s.id)).toEqual(['android-good']);
    expect(repos._membershipRemovals).toEqual([{ subscriptionId: 'ios-bad' }]);

    // Failure event reports invalidToken for the ios sub specifically;
    // an invalidation event also names the platform.
    const failed = events.filter(e => e.event === 'push:delivery.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { reason: string; subscriptionId: string }).reason).toBe(
      'invalidToken',
    );
    expect((failed[0]!.payload as { subscriptionId: string }).subscriptionId).toBe('ios-bad');

    const invalidated = events.filter(e => e.event === 'push:subscription.invalidated');
    expect(invalidated).toHaveLength(1);
    expect((invalidated[0]!.payload as { platform: string }).platform).toBe('ios');
  });

  test('(c) all providers fail — sendToUser returns 0 and emits one failure event per delivery', async () => {
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
      bus: {
        emit: (event, payload) => {
          events.push({ event, payload });
        },
      },
    });

    // Documented contract: per-delivery failures are surfaced via the
    // event bus, not thrown. `sendToUser` resolves with a summary whose
    // `allFailed` flag is true when every attempted delivery failed.
    const result = await router.sendToUser('user-1', { title: 'Hi' });
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(3);
    // The defining contract: when every provider fails, allFailed is true.
    expect(result.allFailed).toBe(true);

    const failedEvents = events.filter(e => e.event === 'push:delivery.failed');
    // One failed event per subscription. (Transient produces one final
    // failure event after retry exhaustion, not one per attempt.)
    expect(failedEvents).toHaveLength(3);
    const reasons = failedEvents.map(e => (e.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual(['invalidToken', 'permanent', 'transient']);

    // Every delivery was persisted as failed.
    expect(repos._deliveries).toHaveLength(3);
    for (const d of repos._deliveries) {
      expect(d.status).toBe('failed');
    }
  });

  test('(d) at-least-one provider succeeds — allFailed is false', async () => {
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

    const result = await router.sendToUser('user-1', { title: 'Hi' });
    expect(result.delivered).toBe(1);
    expect(result.attempted).toBe(3);
    // Even with two failures, allFailed is false because something landed.
    expect(result.allFailed).toBe(false);
  });

  test('(e) user with no subscriptions — allFailed is false (nothing to attempt)', async () => {
    const repos = createFakeRepos();
    const web: PushProvider = {
      platform: 'web',
      send: async () => ({ ok: true }),
    };

    const router = createPushRouter({
      providers: { web },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await router.sendToUser('user-with-none', { title: 'Hi' });
    expect(result.delivered).toBe(0);
    expect(result.attempted).toBe(0);
    // Zero attempts is not failure — there was simply nothing to deliver.
    expect(result.allFailed).toBe(false);
  });
});

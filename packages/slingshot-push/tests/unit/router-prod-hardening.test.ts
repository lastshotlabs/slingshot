import { describe, expect, test, spyOn } from 'bun:test';
import { createPushRouter } from '../../src/router.js';
import type { PushProvider } from '../../src/providers/provider.js';

interface SubscriptionRecord {
  id: string;
  userId: string;
  tenantId: string;
  deviceId: string;
  platform: string;
  platformData: { platform: 'web'; endpoint: string; keys: { auth: string; p256dh: string } };
  createdAt: Date;
  lastSeenAt: Date;
}

interface DeliveryRecord {
  id: string;
  tenantId: string;
  userId: string;
  subscriptionId: string;
  platform: string;
  notificationId?: string | null;
  providerMessageId?: string | null;
  status: string;
  failureReason?: string | null;
  attempts: number;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  createdAt: Date;
}

function makeSubscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'dev-1',
    platform: 'web',
    platformData: {
      platform: 'web',
      endpoint: 'https://push.example/1',
      keys: { auth: 'a', p256dh: 'p' },
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

interface FakeRepos {
  subs: SubscriptionRecord[];
  deliveries: DeliveryRecord[];
  deletedSubIds: string[];
  membershipDeletes: number;
  /** Per-id failure flags for cleanup paths. */
  forceDeleteFailureFor: Set<string>;
  forceMembershipDeleteFailure: boolean;
  // Repo handles in router-shape.
  subscriptions: Record<string, (...args: unknown[]) => unknown>;
  topics: Record<string, (...args: unknown[]) => unknown>;
  topicMemberships: Record<string, (...args: unknown[]) => unknown>;
  deliveriesRepo: Record<string, (...args: unknown[]) => unknown>;
}

function makeRepos(): FakeRepos {
  const r: FakeRepos = {
    subs: [],
    deliveries: [],
    deletedSubIds: [],
    membershipDeletes: 0,
    forceDeleteFailureFor: new Set(),
    forceMembershipDeleteFailure: false,
    subscriptions: {},
    topics: {},
    topicMemberships: {},
    deliveriesRepo: {},
  };
  r.subscriptions = {
    create: async () => makeSubscription(),
    getById: async (id: unknown) => r.subs.find(s => s.id === id) ?? null,
    delete: async (id: unknown) => {
      if (r.forceDeleteFailureFor.has(id as string)) {
        throw new Error('repo: delete failed');
      }
      r.deletedSubIds.push(id as string);
      return true;
    },
    listByUserId: async (params: unknown) => {
      const { userId } = params as { userId: string };
      return r.subs.filter(s => s.userId === userId);
    },
    findByDevice: async () => null,
    touchLastSeen: async () => makeSubscription(),
    upsertByDevice: async () => makeSubscription(),
  };
  r.topics = {
    ensureByName: async () => ({ id: 't1', name: 'test', tenantId: '' }),
    findByName: async () => ({ id: 't1', name: 'test', tenantId: '' }),
  };
  r.topicMemberships = {
    ensureMembership: async () => ({}),
    listByTopic: async () => [],
    removeByTopicAndSub: async () => 0,
    removeBySubscription: async () => {
      if (r.forceMembershipDeleteFailure) throw new Error('repo: membership delete failed');
      r.membershipDeletes += 1;
      return 1;
    },
  };
  r.deliveriesRepo = {
    create: async (input: unknown) => {
      const i = input as { tenantId: string; userId: string; subscriptionId: string; platform: string };
      const d: DeliveryRecord = {
        id: `del-${r.deliveries.length}`,
        tenantId: i.tenantId,
        userId: i.userId,
        subscriptionId: i.subscriptionId,
        platform: i.platform,
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
      };
      r.deliveries.push(d);
      return d;
    },
    getById: async (id: unknown) => r.deliveries.find(d => d.id === id) ?? null,
    markSent: async (params: unknown) => {
      const p = params as { id: string };
      const d = r.deliveries.find(x => x.id === p.id);
      if (d) {
        d.status = 'sent';
        d.sentAt = new Date();
      }
      return d ?? null;
    },
    markDelivered: async (params: unknown) => {
      const p = params as { id: string };
      const d = r.deliveries.find(x => x.id === p.id);
      if (d) {
        d.status = 'delivered';
        d.deliveredAt = new Date();
      }
      return d ?? null;
    },
    markFailed: async (params: unknown) => {
      const p = params as { id: string; failureReason: string };
      const d = r.deliveries.find(x => x.id === p.id);
      if (d) {
        d.status = 'failed';
        d.failureReason = p.failureReason;
      }
      return d ?? null;
    },
    incrementAttempts: async (id: unknown) => {
      const d = r.deliveries.find(x => x.id === id);
      if (d) d.attempts += 1;
      return {};
    },
  };
  return r;
}

function reposBundle(r: FakeRepos) {
  return {
    subscriptions: r.subscriptions as never,
    topics: r.topics as never,
    topicMemberships: r.topicMemberships as never,
    deliveries: r.deliveriesRepo as never,
  };
}

function makeProvider(impl: PushProvider['send']): PushProvider {
  return { platform: 'web', send: impl };
}

/**
 * P-PUSH-8: subscription cleanup must be atomic. markFailed runs first; a
 * subscription delete failure does NOT silently orphan the row — the router
 * emits push:subscription.deletePending so a sweeper can reconcile.
 */
describe('router subscription cleanup atomicity (P-PUSH-8)', () => {
  test('marks failed and emits deletePending when delete fails after markFailed', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const repos = makeRepos();
    repos.subs.push(makeSubscription({ id: 'sub-bad', userId: 'user-1' }));
    repos.forceDeleteFailureFor.add('sub-bad');
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit(event: string, payload: unknown) {
        events.push({ event, payload });
      },
    };
    const router = createPushRouter({
      providers: {
        web: makeProvider(async () => ({ ok: false, reason: 'invalidToken' })),
      },
      repos: reposBundle(repos),
      retries: { maxAttempts: 1 },
      bus,
    });

    await router.sendToUser('user-1', { title: 'x' });

    // Delivery was marked failed before delete attempt.
    expect(repos.deliveries[0]!.status).toBe('failed');
    expect(repos.deliveries[0]!.failureReason).toBe('invalidToken');
    // Delete failed → no record of deletion, no membership purge.
    expect(repos.deletedSubIds).toHaveLength(0);
    expect(repos.membershipDeletes).toBe(0);
    // deletePending event emitted with diagnostic detail.
    const pending = events.find(e => e.event === 'push:subscription.deletePending');
    expect(pending).toBeDefined();
    expect((pending!.payload as { reason: string }).reason).toBe('invalidToken');
  });

  test('emits deletePending when membership cleanup fails (subscription deleted)', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const repos = makeRepos();
    repos.subs.push(makeSubscription({ id: 'sub-mem', userId: 'user-1' }));
    repos.forceMembershipDeleteFailure = true;
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit(event: string, payload: unknown) {
        events.push({ event, payload });
      },
    };
    const router = createPushRouter({
      providers: {
        web: makeProvider(async () => ({ ok: false, reason: 'invalidToken' })),
      },
      repos: reposBundle(repos),
      retries: { maxAttempts: 1 },
      bus,
    });

    await router.sendToUser('user-1', { title: 'x' });

    expect(repos.deletedSubIds).toContain('sub-mem');
    const pending = events.find(e => e.event === 'push:subscription.deletePending');
    expect(pending).toBeDefined();
    expect((pending!.payload as { reason: string }).reason).toBe('membership-cleanup-failed');
  });
});

/**
 * P-PUSH-6: in-flight retry sleeps unwind on stop().
 */
describe('router retry sleep cancellation (P-PUSH-6)', () => {
  test('stop() unwinds in-flight retry sleep so sendToUser settles', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const repos = makeRepos();
    repos.subs.push(makeSubscription({ id: 'sub-x', userId: 'user-1' }));
    let calls = 0;
    const router = createPushRouter({
      providers: {
        web: makeProvider(async () => {
          calls += 1;
          return { ok: false, reason: 'transient', error: 'flaky' };
        }),
      },
      repos: reposBundle(repos),
      retries: { maxAttempts: 5, initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });

    const send = router.sendToUser('user-1', { title: 'x' });
    // Allow the first attempt to run, then abort the lifecycle.
    await new Promise(r => setTimeout(r, 50));
    router.stop();
    const summary = await send;
    // We aborted the sleep, so we should have only one provider call.
    expect(calls).toBe(1);
    expect(summary.attempted).toBe(1);
  });
});

/**
 * P-PUSH-12: the deliveryAdapter overrides router timeout per-call.
 */
describe('router providerTimeoutMs per-call override (P-PUSH-12)', () => {
  test('sendToUser opts.providerTimeoutMs overrides router default', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const repos = makeRepos();
    repos.subs.push(makeSubscription({ id: 'sub-t', userId: 'user-1' }));
    let resolved = false;
    const router = createPushRouter({
      providers: {
        web: makeProvider(
          () =>
            new Promise(r => {
              setTimeout(() => {
                resolved = true;
                r({ ok: true });
              }, 200);
            }),
        ),
      },
      repos: reposBundle(repos),
      retries: { maxAttempts: 1 },
      providerTimeoutMs: 1_000,
    });

    const summary = await router.sendToUser('user-1', { title: 'x' }, { providerTimeoutMs: 25 });
    // The per-call 25ms timeout should fire before the 200ms provider settles.
    expect(summary.delivered).toBe(0);
    expect(summary.attempted).toBe(1);
    expect(resolved).toBe(false);
  });
});

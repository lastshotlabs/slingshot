import { describe, expect, spyOn, test } from 'bun:test';
import type { PushProvider } from '../../src/providers/provider.js';
import { createPushRouter } from '../../src/router.js';

/**
 * P-PUSH-13: there must be no orphaned delivery / subscription if a delete
 * runs concurrently with a delivery. We start a slow provider send and race
 * a subscription delete against it. The router should mark the delivery
 * appropriately and never silently drop state.
 */
describe('concurrent subscription invalidation (P-PUSH-13)', () => {
  test('subscription deleted while delivery in flight produces no orphaned delivery', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const subs: Array<{
      id: string;
      userId: string;
      tenantId: string;
      deviceId: string;
      platform: string;
      platformData: { platform: 'web'; endpoint: string; keys: { auth: string; p256dh: string } };
      createdAt: Date;
      lastSeenAt: Date;
    }> = [
      {
        id: 'sub-1',
        userId: 'user-1',
        tenantId: '',
        deviceId: 'd1',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example/1',
          keys: { auth: 'a', p256dh: 'p' },
        },
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
    ];
    const deliveries: Array<{
      id: string;
      status: string;
      failureReason?: string;
      subscriptionId: string;
      userId: string;
      tenantId: string;
      platform: string;
      attempts: number;
      createdAt: Date;
    }> = [];

    const repos = {
      subscriptions: {
        create: async () => subs[0],
        getById: async (id: string) => subs.find(s => s.id === id) ?? null,
        delete: async (id: string) => {
          const idx = subs.findIndex(s => s.id === id);
          if (idx >= 0) subs.splice(idx, 1);
          return true;
        },
        listByUserId: async (params: { userId: string }) =>
          subs.filter(s => s.userId === params.userId),
        findByDevice: async () => null,
        touchLastSeen: async () => subs[0],
        upsertByDevice: async () => subs[0],
      },
      topics: {
        ensureByName: async () => ({ id: 't', name: 'n', tenantId: '' }),
        findByName: async () => null,
      },
      topicMemberships: {
        ensureMembership: async () => ({}),
        listByTopic: async () => [],
        removeByTopicAndSub: async () => 0,
        removeBySubscription: async () => 1,
      },
      deliveries: {
        create: async (input: {
          tenantId: string;
          userId: string;
          subscriptionId: string;
          platform: string;
        }) => {
          const d = {
            id: `del-${deliveries.length}`,
            ...input,
            status: 'pending' as string,
            attempts: 0,
            createdAt: new Date(),
          };
          deliveries.push(d);
          return d;
        },
        getById: async (id: string) => deliveries.find(d => d.id === id) ?? null,
        markSent: async (params: { id: string }) => {
          const d = deliveries.find(x => x.id === params.id);
          if (d) d.status = 'sent';
          return d ?? null;
        },
        markDelivered: async () => null,
        markFailed: async (params: { id: string; failureReason: string }) => {
          const d = deliveries.find(x => x.id === params.id);
          if (d) {
            d.status = 'failed';
            d.failureReason = params.failureReason;
          }
          return d ?? null;
        },
        incrementAttempts: async (id: string) => {
          const d = deliveries.find(x => x.id === id);
          if (d) d.attempts += 1;
          return {};
        },
      },
    };

    let resolveSend: (v: { ok: boolean }) => void = () => {};
    const provider: PushProvider = {
      platform: 'web',
      send: () =>
        new Promise<{ ok: true }>(r => {
          resolveSend = r as (v: { ok: boolean }) => void;
        }),
    };

    const router = createPushRouter({
      providers: { web: provider },
      repos: repos as never,
      retries: { maxAttempts: 1 },
    });

    const sendPromise = router.sendToUser('user-1', { title: 'x' });
    // Race a delete in mid-flight.
    await new Promise(r => setTimeout(r, 20));
    await repos.subscriptions.delete('sub-1');
    // Allow provider to resolve; router should mark sent regardless.
    resolveSend({ ok: true });
    const summary = await sendPromise;

    // The delivery record exists and reached terminal state.
    expect(deliveries).toHaveLength(1);
    expect(['sent', 'failed']).toContain(deliveries[0]!.status);
    // No orphan: subscription is gone (we deleted it) and delivery has the
    // subscription id recorded for forensic reconciliation.
    expect(deliveries[0]!.subscriptionId).toBe('sub-1');
    expect(subs.find(s => s.id === 'sub-1')).toBeUndefined();
    expect(summary.attempted).toBe(1);
  });
});

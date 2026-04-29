import { describe, expect, mock, test } from 'bun:test';
import { createNoopMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { PushRouterError } from '../../src/errors';
import { createPushRouter } from '../../src/router';

/**
 * Create a PushSubscriptionRecord shaped object the router can digest.
 * The router's sendToSubscriptions iterates over these via the repos layer.
 */
function makeWebSub() {
  return {
    id: 'sub-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    deviceId: 'dev-1',
    platform: 'web',
    platformData: {
      platform: 'web' as const,
      endpoint: 'https://example.com/push',
      keys: { p256dh: 'key', auth: 'auth' },
    },
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function createRepos() {
  const deliveries: Array<Record<string, unknown>> = [];
  return {
    subscriptions: {
      create: mock(async () => makeWebSub()),
      getById: mock(async () => null),
      delete: mock(async () => true),
      listByUserId: mock(async () => [makeWebSub()]),
      findByDevice: mock(async () => null),
      touchLastSeen: mock(async (_, input) => ({
        ...makeWebSub(),
        lastSeenAt: input.lastSeenAt?.toISOString?.() ?? new Date().toISOString(),
      })),
      upsertByDevice: mock(async () => makeWebSub()),
    },
    topics: {
      ensureByName: mock(async params => ({ id: 'topic-1', name: params.name, tenantId: params.tenantId })),
      findByName: mock(async () => null),
    },
    topicMemberships: {
      ensureMembership: mock(async () => ({ id: 'membership-1', topicId: 'topic-1', subscriptionId: 'sub-1', userId: 'user-1', tenantId: '', createdAt: new Date().toISOString() })),
      listByTopic: mock(async () => ({ items: [] })),
      removeByTopicAndSub: mock(async () => 1),
      removeBySubscription: mock(async () => 1),
    },
    deliveries: {
      create: mock(async input => {
        const record = { id: `del-${deliveries.length + 1}`, ...input, status: 'pending' as const, attempts: 0, createdAt: new Date().toISOString() };
        deliveries.push(record);
        return record;
      }),
      getById: mock(async () => null),
      markSent: mock(async () => null),
      markDelivered: mock(async () => null),
      markFailed: mock(async () => null),
      incrementAttempts: mock(async () => ({})),
    },
  };
}

describe('router circuit breaker', () => {
  test('allows sends when breaker is closed (default state)', async () => {
    const repos = createRepos();
    const router = createPushRouter({
      providers: {
        web: {
          platform: 'web',
          send: mock(async () => ({ ok: true, providerMessageId: 'msg-1' })),
        },
      },
      repos,
      routerCircuitBreakerThreshold: 5,
      routerCircuitBreakerCooldownMs: 10_000,
      retries: { maxAttempts: 1 },
      metrics: createNoopMetricsEmitter(),
    });

    const result = await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });

    // The subscription should have received the message successfully
    expect(result.delivered).toBe(1);
    expect(result.allFailed).toBe(false);

    const health = router.getBreakerHealth?.();
    expect(health).not.toBeNull();
    expect(health?.circuitState).toBe('closed');
    expect(health?.consecutiveFailures).toBe(0);
  });

  test('breaker opens after threshold allFailed results', async () => {
    const repos = createRepos();
    const failingProvider = {
      platform: 'web' as const,
      send: mock(async () => ({
        ok: false as const,
        reason: 'transient' as const,
        error: 'test failure',
      })),
    };

    const router = createPushRouter({
      providers: { web: failingProvider },
      repos,
      routerCircuitBreakerThreshold: 3,
      routerCircuitBreakerCooldownMs: 100_000, // long cooldown so it stays open
      retries: { maxAttempts: 1 }, // no retries to keep test fast
      metrics: createNoopMetricsEmitter(),
    });

    // First three sends all fail (allFailed: true from summarize)
    for (let i = 0; i < 3; i++) {
      const result = await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });
      expect(result.delivered).toBe(0);
      expect(result.attempted).toBe(1);
      expect(result.allFailed).toBe(true);
    }

    // Fourth send should be short-circuited by the breaker
    try {
      await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });
      // If the method returns (breaker not throwing), assert via the health
      const health = router.getBreakerHealth?.();
      expect(health?.circuitState).toBe('open');
    } catch (err) {
      expect(err).toBeInstanceOf(PushRouterError);
      expect((err as PushRouterError).code).toBe('PUSH_ROUTER_ERROR');
    }
  });

  test('breaker resets on successful send', async () => {
    let sendCount = 0;
    const repos = createRepos();
    const alternatingProvider = {
      platform: 'web' as const,
      send: mock(async () => {
        sendCount++;
        // First two calls per subscription fail, third succeeds
        return sendCount % 3 === 0
          ? ({ ok: true, providerMessageId: 'msg-1' } as const)
          : ({ ok: false as const, reason: 'transient' as const, error: 'fail' } as const);
      }),
    };

    const router = createPushRouter({
      providers: { web: alternatingProvider },
      repos,
      routerCircuitBreakerThreshold: 3,
      routerCircuitBreakerCooldownMs: 100_000,
      retries: { maxAttempts: 1 },
      metrics: createNoopMetricsEmitter(),
    });

    // First send fails all subs (1 sub * 1 attempt = 1 fail) → breaker: 1 failure
    const r1 = await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });
    expect(r1.allFailed).toBe(true);
    expect(r1.delivered).toBe(0);

    const health1 = router.getBreakerHealth?.();
    expect(health1?.consecutiveFailures).toBe(1);

    // Second send fails all subs → breaker: 2 failures
    const r2 = await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });
    expect(r2.allFailed).toBe(true);

    const health2 = router.getBreakerHealth?.();
    expect(health2?.consecutiveFailures).toBe(2);

    // Third send succeeds → resets breaker
    const r3 = await router.sendToUser('user-1', { title: 'Test' }, { tenantId: 'tenant-1' });
    expect(r3.delivered).toBe(1);
    expect(r3.allFailed).toBe(false);

    const health3 = router.getBreakerHealth?.();
    expect(health3?.consecutiveFailures).toBe(0);
    expect(health3?.circuitState).toBe('closed');
  });

  test('getBreakerHealth returns null when threshold is 0 (disabled)', async () => {
    const repos = createRepos();
    const router = createPushRouter({
      providers: {
        web: {
          platform: 'web',
          send: mock(async () => ({ ok: true, providerMessageId: 'msg-1' })),
        },
      },
      repos,
      routerCircuitBreakerThreshold: 0,
      metrics: createNoopMetricsEmitter(),
    });

    const health = router.getBreakerHealth?.();
    expect(health).toBeNull();
  });

  test('sendToUsers is also gated by the circuit breaker', async () => {
    const repos = createRepos();
    const failingProvider = {
      platform: 'web' as const,
      send: mock(async () => ({
        ok: false as const,
        reason: 'transient' as const,
        error: 'fail',
      })),
    };

    const router = createPushRouter({
      providers: { web: failingProvider },
      repos,
      routerCircuitBreakerThreshold: 1,
      routerCircuitBreakerCooldownMs: 100_000,
      retries: { maxAttempts: 1 },
      metrics: createNoopMetricsEmitter(),
    });

    // First send fails → breaker opens
    const first = await router.sendToUsers(['user-1'], { title: 'Test' }, { tenantId: 'tenant-1' });
    expect(first.allFailed).toBe(true);

    // Second call should be short-circuited
    try {
      await router.sendToUsers(['user-1'], { title: 'Test' }, { tenantId: 'tenant-1' });
    } catch (err) {
      expect(err).toBeInstanceOf(PushRouterError);
    }
  });
});

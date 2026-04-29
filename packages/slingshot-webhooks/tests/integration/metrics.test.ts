/**
 * Unified metrics emitter integration tests for slingshot-webhooks.
 *
 * Wires an in-process MetricsEmitter into the plugin via the test app helper
 * and asserts that the expected webhooks.* counters / gauges / timings appear
 * in the snapshot after running representative success and failure deliveries.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { createWebhooksTestApp } from '../../src/testing';
import type { WebhookDelivery } from '../../src/types/models';

const originalFetch = globalThis.fetch;

function asFetch(value: ReturnType<typeof mock<() => Promise<Response>>>): typeof fetch {
  return value as unknown as typeof fetch;
}

function adminHeaders(tenantId = 'tenant-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'admin-user',
    'x-role': 'admin',
    'x-tenant-id': tenantId,
  };
}

async function createEndpoint(
  app: Awaited<ReturnType<typeof createWebhooksTestApp>>['app'],
  headers: Record<string, string>,
  subscriptions: Array<{ event: string } | { pattern: string }>,
): Promise<string> {
  const response = await app.request('/webhooks/endpoints', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ownerType: 'user',
      ownerId: 'user-1',
      url: 'https://example.com/hooks/test',
      secret: 'super-secret-token',
      subscriptions,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function waitForDelivery(
  runtime: Awaited<ReturnType<typeof createWebhooksTestApp>>['runtime'],
  endpointId: string,
  predicate: (delivery: WebhookDelivery) => boolean,
): Promise<WebhookDelivery> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const page = await runtime.listDeliveries({ endpointId });
    const match = page.items.find(predicate);
    if (match) {
      return match;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for delivery on endpoint ${endpointId}`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('webhooks plugin — metrics emitter', () => {
  it('records webhooks.delivery.count success and webhooks.delivery.duration on a clean delivery', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);
    const metrics = createInProcessMetricsEmitter();

    const { app, events, runtime, teardown } = await createWebhooksTestApp(
      {
        events: ['auth:*'],
      },
      { metricsEmitter: metrics },
    );

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-1', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      await waitForDelivery(runtime, endpointId, item => item.status === 'delivered');

      const snap = metrics.snapshot();
      const success = snap.counters.find(
        c => c.name === 'webhooks.delivery.count' && c.labels.result === 'success',
      );
      expect(success?.value).toBeGreaterThanOrEqual(1);

      const duration = snap.timings.find(t => t.name === 'webhooks.delivery.duration');
      expect(duration).toBeDefined();
      expect(duration?.count).toBeGreaterThanOrEqual(1);
      expect(duration?.min).toBeGreaterThanOrEqual(0);

      const depth = snap.gauges.find(g => g.name === 'webhooks.queue.depth');
      expect(depth).toBeDefined();
    } finally {
      await teardown();
    }
  });

  it('records webhooks.dlq.count when delivery exhausts its retries', async () => {
    const fetchMock = mock(async () => new Response('upstream error', { status: 500 }));
    globalThis.fetch = asFetch(fetchMock);
    const metrics = createInProcessMetricsEmitter();

    const { app, events, runtime, teardown } = await createWebhooksTestApp(
      {
        events: ['auth:*'],
        queueConfig: { maxAttempts: 2, retryBaseDelayMs: 1 },
      },
      { metricsEmitter: metrics },
    );

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-2', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      await waitForDelivery(runtime, endpointId, item => item.status === 'dead');

      const snap = metrics.snapshot();
      const failure = snap.counters.find(
        c => c.name === 'webhooks.delivery.count' && c.labels.result === 'failure',
      );
      expect(failure?.value).toBeGreaterThanOrEqual(2);

      const dlq = snap.counters.find(c => c.name === 'webhooks.dlq.count');
      expect(dlq?.value).toBe(1);
    } finally {
      await teardown();
    }
  });
});

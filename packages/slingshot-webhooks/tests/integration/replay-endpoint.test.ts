import { describe, expect, it, mock } from 'bun:test';
import { createWebhooksTestApp } from '../../src/testing';
import type { WebhookPluginConfig } from '../../src/types/config';
import type { WebhookDelivery } from '../../src/types/models';

const PUBLIC_RESOLVE = async () => [{ address: '93.184.216.34', family: 4 as const }];

function asFetch(value: ReturnType<typeof mock<() => Promise<Response>>>): typeof fetch {
  return value as unknown as typeof fetch;
}

function dispatchFor(
  fetchMock: ReturnType<typeof mock<() => Promise<Response>>>,
): NonNullable<WebhookPluginConfig['dispatch']> {
  return {
    fetchImpl: asFetch(fetchMock),
    safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
  };
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
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for delivery on endpoint ${endpointId}`);
}

describe('webhook replay endpoint', () => {
  /**
   * P-WEBHOOKS-10: The replay endpoint (POST /webhooks/admin/deliveries/:id/replay)
   * re-queues a failed delivery by resetting its attempt count and enqueuing a fresh
   * job on the delivery queue. The endpoint requires admin role.
   */
  it('re-queues a failed delivery and resets its status to pending', async () => {
    // Return 400 so the delivery fails immediately (non-retryable).
    const fetchMock = mock(async () => new Response('bad request', { status: 400 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      queueConfig: { maxAttempts: 1, retryBaseDelayMs: 1 },
      dispatch: dispatchFor(fetchMock),
    });

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-1', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      // Wait for the delivery to fail and become dead.
      const deadDelivery = await waitForDelivery(runtime, endpointId, d => d.status === 'dead');
      expect(deadDelivery.status).toBe('dead');

      // Replay the dead delivery.
      const replayRes = await app.request(`/webhooks/admin/deliveries/${deadDelivery.id}/replay`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as {
        replayed: boolean;
        deliveryId: string;
      };
      expect(replayBody.replayed).toBe(true);
      expect(replayBody.deliveryId).toBe(deadDelivery.id);

      // The delivery should now be pending again (reset by the replay).
      const refreshed = await runtime.getDelivery(deadDelivery.id);
      expect(refreshed?.status).toBe('pending');
    } finally {
      await teardown();
    }
  });

  it('returns 404 when the delivery does not exist', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/admin/deliveries/non-existent-id/replay', {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Delivery not found');
    } finally {
      await teardown();
    }
  });

  it('returns 400 when the delivery was already delivered', async () => {
    // Use a URL that returns 200 so the delivery succeeds.
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      dispatch: dispatchFor(fetchMock),
    });

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-2', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      const delivered = await waitForDelivery(runtime, endpointId, d => d.status === 'delivered');

      const res = await app.request(`/webhooks/admin/deliveries/${delivered.id}/replay`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Cannot replay a delivered webhook');
    } finally {
      await teardown();
    }
  });

  it('requires admin role', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/admin/deliveries/some-id/replay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'regular-user',
          'x-role': 'user',
        },
      });
      expect(res.status).toBe(403);
    } finally {
      await teardown();
    }
  });
});

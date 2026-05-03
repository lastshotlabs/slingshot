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
      url: 'https://example.com/hooks/delivery-lifecycle',
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
  for (let attempt = 0; attempt < 60; attempt++) {
    const page = await runtime.listDeliveries({ endpointId });
    const match = page.items.find(predicate);
    if (match) {
      return match;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for delivery on endpoint ${endpointId}`);
}

describe('webhook delivery lifecycle', () => {
  it('completes a successful delivery: pending -> delivered', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-1', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      const delivery = await waitForDelivery(runtime, endpointId, d => d.status === 'delivered');

      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts).toBe(1);
      expect(delivery.event).toBe('auth:login');
      expect(delivery.lastAttempt).toBeDefined();
      // Successful deliveries record attemptedAt + durationMs, not statusCode
      expect(delivery.lastAttempt?.attemptedAt).toBeDefined();
      expect(delivery.lastAttempt?.durationMs).toBeGreaterThanOrEqual(0);
      expect(delivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Verify delivery is observable via HTTP detail route
      const detailRes = await app.request(
        `/webhooks/endpoints/${endpointId}/deliveries/${delivery.id}`,
        { headers: adminHeaders() },
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as Record<string, unknown>;
      expect(detail.status).toBe('delivered');
      expect(detail.attempts).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('transitions from pending to dead when non-retryable failure occurs', async () => {
    const fetchMock = mock(async () => new Response('bad request', { status: 400 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      queueConfig: { maxAttempts: 3, retryBaseDelayMs: 1 },
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-2', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      const delivery = await waitForDelivery(runtime, endpointId, d => d.status === 'dead');

      // Non-retryable 400 goes dead immediately with 1 attempt
      expect(delivery.attempts).toBe(1);
      expect(delivery.lastAttempt?.statusCode).toBe(400);
      expect(delivery.lastAttempt?.error).toContain('HTTP 400');
      expect(delivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await teardown();
    }
  });

  it('exhausts retries for retryable failures and reaches dead', async () => {
    const fetchMock = mock(async () => new Response('upstream error', { status: 500 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      queueConfig: { maxAttempts: 3, retryBaseDelayMs: 1 },
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-3', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      const delivery = await waitForDelivery(runtime, endpointId, d => d.status === 'dead');

      // All 3 attempts were made before going dead
      expect(delivery.attempts).toBe(3);
      expect(delivery.lastAttempt?.statusCode).toBe(500);
      expect(delivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await teardown();
    }
  });

  it('replays a dead delivery and delivers successfully', async () => {
    // First attempt: fail with non-retryable 400 (goes dead immediately)
    // Then replay via HTTP route and succeed
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
        { userId: 'user-1', sessionId: 'sess-4', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      // Wait for delivery to fail and become dead
      const deadDelivery = await waitForDelivery(runtime, endpointId, d => d.status === 'dead');
      expect(deadDelivery.status).toBe('dead');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Update the mock to return success for the replay
      fetchMock.mockImplementation(async () => new Response('ok', { status: 200 }));

      // Replay the delivery via the HTTP route
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

      // Verify delivery is now pending (reset by replay)
      const pendingDelivery = await waitForDelivery(
        runtime,
        endpointId,
        d => d.status === 'pending',
      );
      expect(pendingDelivery.status).toBe('pending');

      // Wait for the replay delivery to succeed
      const deliveredDelivery = await waitForDelivery(
        runtime,
        endpointId,
        d => d.status === 'delivered' && d.attempts === 1,
      );
      expect(deliveredDelivery.status).toBe('delivered');
      expect(deliveredDelivery.attempts).toBe(1);
      // Successful deliveries record attemptedAt + durationMs, not statusCode
      expect(deliveredDelivery.lastAttempt?.attemptedAt).toBeDefined();
      expect(deliveredDelivery.lastAttempt?.durationMs).toBeGreaterThanOrEqual(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await teardown();
    }
  });

  it('tracks attempt metadata including status code and error message', async () => {
    const fetchMock = mock(async () => new Response('rate limited', { status: 429 }));

    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      queueConfig: { maxAttempts: 2, retryBaseDelayMs: 1 },
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-5', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      // Wait for the final dead state (429 is retryable, goes failed → dead)
      const deadDelivery = await waitForDelivery(runtime, endpointId, d => d.status === 'dead');
      expect(deadDelivery.attempts).toBe(2);
      expect(deadDelivery.lastAttempt?.statusCode).toBe(429);
      expect(deadDelivery.lastAttempt?.error).toContain('HTTP 429');
      expect(deadDelivery.lastAttempt?.durationMs).toBeGreaterThanOrEqual(0);
      expect(deadDelivery.lastAttempt?.attemptedAt).toBeDefined();
      expect(deadDelivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await teardown();
    }
  });
});

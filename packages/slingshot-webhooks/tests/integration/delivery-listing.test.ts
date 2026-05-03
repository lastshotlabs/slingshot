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

function userHeaders(tenantId = 'tenant-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'regular-user',
    'x-role': 'user',
    'x-tenant-id': tenantId,
  };
}

async function createEndpoint(
  app: Awaited<ReturnType<typeof createWebhooksTestApp>>['app'],
  headers: Record<string, string>,
  subscriptions: Array<{ event: string } | { pattern: string }>,
  url = 'https://example.com/hooks/delivery-listing',
): Promise<string> {
  const response = await app.request('/webhooks/endpoints', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ownerType: 'user',
      ownerId: 'user-1',
      url,
      secret: 'test-secret',
      subscriptions,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function waitForDeliveries(
  runtime: Awaited<ReturnType<typeof createWebhooksTestApp>>['runtime'],
  endpointId: string,
  expectedCount: number,
  expectedStatus: WebhookDelivery['status'],
): Promise<WebhookDelivery[]> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const page = await runtime.listDeliveries({ endpointId });
    const matching = page.items.filter(d => d.status === expectedStatus);
    if (matching.length >= expectedCount) {
      return matching;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} delivery(ies) with status ${expectedStatus} on endpoint ${endpointId}`,
  );
}

describe('webhook delivery listing via HTTP routes', () => {
  it('lists deliveries for an endpoint', async () => {
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

      await waitForDeliveries(runtime, endpointId, 1, 'delivered');

      const listRes = await app.request(`/webhooks/endpoints/${endpointId}/deliveries`, {
        headers: adminHeaders(),
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        items: Array<Record<string, unknown>>;
        hasMore: boolean;
      };
      expect(list.items.length).toBe(1);
      expect(list.items[0].status).toBe('delivered');
      expect(list.items[0].endpointId).toBe(endpointId);
      expect(list.hasMore).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('paginates deliveries using limit and cursor', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);

      // Publish 5 events to create 5 deliveries
      for (let i = 0; i < 5; i++) {
        events.publish(
          'auth:login',
          { userId: 'user-1', sessionId: `sess-${i}`, tenantId: 'tenant-a' },
          { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
        );
      }

      await waitForDeliveries(runtime, endpointId, 5, 'delivered');

      // Verify all 5 are visible without pagination
      const allRes = await app.request(`/webhooks/endpoints/${endpointId}/deliveries?limit=10`, {
        headers: adminHeaders(),
      });
      expect(allRes.status).toBe(200);
      const allData = (await allRes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(allData.items.length).toBe(5);

      // First page: limit=2
      const page1Res = await app.request(`/webhooks/endpoints/${endpointId}/deliveries?limit=2`, {
        headers: adminHeaders(),
      });
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        items: Array<Record<string, unknown>>;
        nextCursor?: string;
        hasMore: boolean;
      };
      expect(page1.items.length).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page using cursor
      const page2Res = await app.request(
        `/webhooks/endpoints/${endpointId}/deliveries?limit=2&cursor=${page1.nextCursor}`,
        { headers: adminHeaders() },
      );
      expect(page2Res.status).toBe(200);
      const page2 = (await page2Res.json()) as {
        items: Array<Record<string, unknown>>;
        nextCursor?: string;
        hasMore: boolean;
      };
      expect(page2.items.length).toBe(2);
      expect(page2.hasMore).toBe(true);

      // Third page fetching remaining item
      const page3Res = await app.request(
        `/webhooks/endpoints/${endpointId}/deliveries?limit=2&cursor=${page2.nextCursor}`,
        { headers: adminHeaders() },
      );
      expect(page3Res.status).toBe(200);
      const page3 = (await page3Res.json()) as {
        items: Array<Record<string, unknown>>;
        hasMore: boolean;
      };
      expect(page3.items.length).toBe(1);
      expect(page3.hasMore).toBe(false);

      // Verify no overlap — all IDs are unique
      const allIds = [...page1.items, ...page2.items, ...page3.items].map(
        (i: Record<string, unknown>) => i.id as string,
      );
      expect(new Set(allIds).size).toBe(5);
    } finally {
      await teardown();
    }
  });

  it('filters deliveries by status using query parameter', async () => {
    // Use a mock that returns 500 so we can create failed/dead deliveries
    const fetchMock = mock(async () => new Response('upstream error', { status: 500 }));
    const fetchOkMock = mock(async () => new Response('ok', { status: 200 }));

    // We'll create two endpoints: one with success, one with failure
    // Use the success endpoint first
    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      queueConfig: { maxAttempts: 2, retryBaseDelayMs: 1 },
      dispatch: dispatchFor(fetchOkMock),
    });
    try {
      const endpointId = await createEndpoint(app, adminHeaders(), [{ event: 'auth:login' }]);

      // Publish a single event to create a delivered delivery
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-0', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      await waitForDeliveries(runtime, endpointId, 1, 'delivered');

      // List with status=delivered filter
      const filteredRes = await app.request(
        `/webhooks/endpoints/${endpointId}/deliveries?status=delivered`,
        { headers: adminHeaders() },
      );
      expect(filteredRes.status).toBe(200);
      const filtered = (await filteredRes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(filtered.items.length).toBe(1);
      expect(filtered.items[0].status).toBe('delivered');
    } finally {
      await teardown();
    }
  });

  it('returns a single delivery detail', async () => {
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

      const deliveries = await waitForDeliveries(runtime, endpointId, 1, 'delivered');
      const deliveryId = deliveries[0].id;

      // Get delivery detail via HTTP route
      const detailRes = await app.request(
        `/webhooks/endpoints/${endpointId}/deliveries/${deliveryId}`,
        { headers: adminHeaders() },
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as Record<string, unknown>;
      expect(detail.id).toBe(deliveryId);
      expect(detail.endpointId).toBe(endpointId);
      expect(detail.status).toBe('delivered');
      expect(detail.event).toBe('auth:login');
      expect(detail.attempts).toBe(1);
      expect(detail.lastAttempt).toBeDefined();
      // Successful deliveries record attemptedAt + durationMs but not statusCode
      expect((detail.lastAttempt as Record<string, unknown>).attemptedAt).toBeDefined();
      expect((detail.lastAttempt as Record<string, unknown>).durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await teardown();
    }
  });

  it('returns 404 for a non-existent delivery detail', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request(
        '/webhooks/endpoints/fake-endpoint/deliveries/non-existent-delivery',
        { headers: adminHeaders() },
      );
      expect(res.status).toBe(404);
    } finally {
      await teardown();
    }
  });

  it('requires admin role for listing deliveries', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints/some-endpoint/deliveries', {
        headers: userHeaders(),
      });
      expect(res.status).toBe(403);
    } finally {
      await teardown();
    }
  });

  it('lists deliveries across multiple endpoints', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const { app, events, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:*'],
      dispatch: dispatchFor(fetchMock),
    });
    try {
      const endpointA = await createEndpoint(
        app,
        adminHeaders(),
        [{ event: 'auth:login' }],
        'https://example.com/hooks/endpoint-a',
      );
      const endpointB = await createEndpoint(
        app,
        adminHeaders(),
        [{ event: 'auth:login' }],
        'https://example.com/hooks/endpoint-b',
      );

      // Publish two events: one for each endpoint
      // Both endpoints subscribe to auth:login, so each publish creates only
      // one delivery (per event, each endpoint gets its own delivery).
      // We publish twice so each endpoint gets one delivery.
      events.publish(
        'auth:login',
        { userId: 'user-1', sessionId: 'sess-a', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-1', actorId: 'user-1' },
      );

      await Promise.all([
        waitForDeliveries(runtime, endpointA, 1, 'delivered'),
        waitForDeliveries(runtime, endpointB, 1, 'delivered'),
      ]);

      // List deliveries for endpoint A
      const listARes = await app.request(`/webhooks/endpoints/${endpointA}/deliveries`, {
        headers: adminHeaders(),
      });
      expect(listARes.status).toBe(200);
      const listA = (await listARes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(listA.items.length).toBe(1);
      expect(listA.items[0].endpointId).toBe(endpointA);

      // List deliveries for endpoint B
      const listBRes = await app.request(`/webhooks/endpoints/${endpointB}/deliveries`, {
        headers: adminHeaders(),
      });
      expect(listBRes.status).toBe(200);
      const listB = (await listBRes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(listB.items.length).toBe(1);
      expect(listB.items[0].endpointId).toBe(endpointB);
    } finally {
      await teardown();
    }
  });
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createMemoryWebhookAdapter } from '../../src/adapters/memory';
import { createWebhooksTestApp } from '../../src/testing';

const originalFetch = globalThis.fetch;

function asFetch(value: ReturnType<typeof mock<() => Promise<Response>>>): typeof fetch {
  return value as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function adminHeaders(tenantId = 'tenant-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'admin-user',
    'x-role': 'admin',
    'x-tenant-id': tenantId,
  };
}

describe('standalone adapter mode', () => {
  test('boots without slingshot-entity using standalone: true', async () => {
    const { runtime, teardown } = await createWebhooksTestApp(
      { events: ['auth:*'] },
      { standalone: true },
    );

    try {
      expect(runtime).toBeDefined();
      expect(typeof runtime.getEndpoint).toBe('function');
      expect(typeof runtime.listEnabledEndpoints).toBe('function');
      expect(typeof runtime.createDelivery).toBe('function');
      expect(typeof runtime.updateDelivery).toBe('function');
      expect(typeof runtime.getDelivery).toBe('function');
      expect(typeof runtime.listDeliveries).toBe('function');
    } finally {
      await teardown();
    }
  });

  test('boots with an explicitly provided memory adapter', async () => {
    const adapter = createMemoryWebhookAdapter();

    const { runtime, teardown } = await createWebhooksTestApp({
      adapter,
      events: ['auth:*'],
    });

    try {
      expect(runtime).toBe(adapter);
    } finally {
      await teardown();
    }
  });

  test('delivers webhooks end-to-end in standalone mode', async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-1',
      ownerType: 'user',
      ownerId: 'user-123',
      tenantId: 'tenant-a',
      url: 'https://example.com/hooks/auth',
      secret: 'test-secret',
      subscriptions: [{ event: 'auth:login', exposure: 'user-webhook' }],
      enabled: true,
    });

    const { events, runtime, teardown } = await createWebhooksTestApp({
      adapter,
      events: ['auth:*'],
    });

    try {
      events.publish(
        'auth:login',
        { userId: 'user-123', sessionId: 'sess-1', tenantId: 'tenant-a' },
        { requestTenantId: 'tenant-a', userId: 'user-123', actorId: 'user-123' },
      );
      await new Promise(resolve => setTimeout(resolve, 100));

      const page = await runtime.listDeliveries({ endpointId: 'ep-1' });
      expect(page.items.length).toBe(1);
      expect(page.items[0]).toMatchObject({
        event: 'auth:login',
        subscriber: { ownerType: 'user', ownerId: 'user-123', tenantId: 'tenant-a' },
        status: 'delivered',
        attempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await teardown();
    }
  });

  test('test endpoint sends synthetic event synchronously and returns upstream status (P-WEBHOOKS-7)', async () => {
    // P-WEBHOOKS-7: the test endpoint sends synchronously and surfaces the
    // upstream response. The fetch mock returns 200 OK with a body, and we
    // expect the route to forward both the status and body.
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = asFetch(fetchMock);

    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-test',
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      tenantId: 'tenant-a',
      url: 'https://example.com/hooks/test',
      secret: 'test-secret',
      subscriptions: [{ event: 'auth:login', exposure: 'user-webhook' }],
      enabled: true,
    });

    const { app, teardown } = await createWebhooksTestApp({
      adapter,
      events: ['auth:*'],
    });

    try {
      const res = await app.request('/webhooks/endpoints/ep-test/test', {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: number;
        ok: boolean;
        body: string;
        durationMs: number;
      };
      expect(body.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.body).toContain('received');
      // Verify the X-Webhook-Test header was on the outbound request.
      const fetchArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const sentHeaders = new Headers(fetchArgs[1]?.headers ?? {});
      expect(sentHeaders.get('X-Webhook-Test')).toBe('true');
    } finally {
      await teardown();
    }
  });

  test('memory adapter enforces delivery state transitions', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-1',
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      tenantId: 'tenant-a',
      url: 'https://example.com/hook',
      secret: 's',
      subscriptions: [{ event: 'auth:login', exposure: 'user-webhook' }],
      enabled: true,
    });

    const delivery = await adapter.createDelivery({
      endpointId: 'ep-1',
      event: 'auth:login',
      eventId: 'evt-1',
      occurredAt: new Date().toISOString(),
      subscriber: {
        ownerType: 'tenant',
        ownerId: 'tenant-a',
        tenantId: 'tenant-a',
      },
      sourceScope: { tenantId: 'tenant-a', userId: 'user-1' },
      payload: '{}',
      maxAttempts: 3,
    });
    expect(delivery.status).toBe('pending');

    await adapter.updateDelivery(delivery.id, { status: 'delivered' });

    await expect(adapter.updateDelivery(delivery.id, { status: 'pending' })).rejects.toThrow(
      "Invalid delivery transition from 'delivered' to 'pending'",
    );
  });

  test('memory adapter lists only enabled endpoints', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-active',
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      tenantId: 'tenant-a',
      url: 'https://a.example.com/hook',
      secret: 's',
      subscriptions: [{ event: 'auth:login', exposure: 'user-webhook' }],
      enabled: true,
    });
    adapter.addEndpoint({
      id: 'ep-disabled',
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      tenantId: 'tenant-a',
      url: 'https://b.example.com/hook',
      secret: 's',
      subscriptions: [{ event: 'auth:login', exposure: 'user-webhook' }],
      enabled: false,
    });

    const matches = await adapter.listEnabledEndpoints();
    expect(matches.map(endpoint => endpoint.id)).toEqual(['ep-active']);
  });
});

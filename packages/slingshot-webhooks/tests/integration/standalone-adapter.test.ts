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
    const { app, runtime, teardown } = await createWebhooksTestApp(
      { events: ['order.*'] },
      { standalone: true },
    );

    try {
      expect(runtime).toBeDefined();
      expect(typeof runtime.getEndpoint).toBe('function');
      expect(typeof runtime.findEndpointsForEvent).toBe('function');
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
      events: ['order.*'],
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
      tenantId: 'tenant-a',
      url: 'https://example.com/hooks/orders',
      secret: 'test-secret',
      events: ['order.*'],
      enabled: true,
    });

    const { bus, runtime, teardown } = await createWebhooksTestApp({
      adapter,
      events: ['order.*'],
      extraEventKeys: ['order.created'],
    });

    try {
      bus.emit('order.created', { orderId: '123', tenantId: 'tenant-a' });
      await new Promise(resolve => setTimeout(resolve, 100));

      const page = await runtime.listDeliveries({ endpointId: 'ep-1' });
      expect(page.items.length).toBe(1);
      expect(page.items[0]).toMatchObject({
        event: 'order.created',
        status: 'delivered',
        attempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await teardown();
    }
  });

  test('test endpoint works in standalone mode', async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-test',
      tenantId: 'tenant-a',
      url: 'https://example.com/hooks/test',
      secret: 'test-secret',
      events: ['*'],
      enabled: true,
    });

    const { app, runtime, teardown } = await createWebhooksTestApp({
      adapter,
      events: ['*'],
    });

    try {
      const res = await app.request('/webhooks/endpoints/ep-test/test', {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deliveryId: string };
      expect(typeof body.deliveryId).toBe('string');

      await new Promise(resolve => setTimeout(resolve, 100));
      const delivery = await runtime.getDelivery(body.deliveryId);
      expect(delivery).not.toBeNull();
      expect(delivery!.event).toBe('webhook:test');
    } finally {
      await teardown();
    }
  });

  test('memory adapter enforces delivery state transitions', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-1',
      tenantId: null,
      url: 'https://example.com/hook',
      secret: 's',
      events: ['*'],
      enabled: true,
    });

    const delivery = await adapter.createDelivery({
      endpointId: 'ep-1',
      event: 'test',
      payload: '{}',
      maxAttempts: 3,
    });
    expect(delivery.status).toBe('pending');

    await adapter.updateDelivery(delivery.id, { status: 'delivered' });

    // delivered → pending is not allowed
    await expect(
      adapter.updateDelivery(delivery.id, { status: 'pending' }),
    ).rejects.toThrow("Invalid delivery transition from 'delivered' to 'pending'");
  });

  test('memory adapter filters endpoints by enabled and glob pattern', async () => {
    const adapter = createMemoryWebhookAdapter();
    adapter.addEndpoint({
      id: 'ep-active',
      tenantId: null,
      url: 'https://a.example.com/hook',
      secret: 's',
      events: ['order.*'],
      enabled: true,
    });
    adapter.addEndpoint({
      id: 'ep-disabled',
      tenantId: null,
      url: 'https://b.example.com/hook',
      secret: 's',
      events: ['order.*'],
      enabled: false,
    });
    adapter.addEndpoint({
      id: 'ep-other',
      tenantId: null,
      url: 'https://c.example.com/hook',
      secret: 's',
      events: ['user.*'],
      enabled: true,
    });

    const matches = await adapter.findEndpointsForEvent('order.created');
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe('ep-active');
  });
});

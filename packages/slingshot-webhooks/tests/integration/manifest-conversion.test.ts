import { afterEach, describe, expect, mock, test } from 'bun:test';
import { webhooksManifest } from '../../src';
import { createWebhooksTestApp } from '../../src/testing';

const originalFetch = globalThis.fetch;

function asFetch(value: ReturnType<typeof mock<() => Promise<Response>>>): typeof fetch {
  return value as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('webhooks manifest conversion', () => {
  test('boots from webhooksManifest and completes an outbound delivery cycle', async () => {
    expect(webhooksManifest.manifestVersion).toBe(1);

    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    const { app, bus } = await createWebhooksTestApp({
      events: ['auth:*'],
    });

    const createEndpoint = await app.request('/webhooks/endpoints', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'admin-user',
        'x-role': 'admin',
        'x-tenant-id': 'tenant-a',
      },
      body: JSON.stringify({
        url: 'https://example.com/hooks/auth',
        secret: 'super-secret-token',
        events: ['auth:*'],
      }),
    });
    expect(createEndpoint.status).toBe(201);
    const createdEndpoint = (await createEndpoint.json()) as {
      id: string;
      secret: string;
      enabled: boolean;
    };
    expect(createdEndpoint.enabled).toBe(true);
    expect(createdEndpoint.secret).toBe('oken');

    bus.emit('auth:user.created', {
      userId: 'user-1',
      email: 'user@example.com',
      tenantId: 'tenant-a',
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    const listDeliveries = await app.request(
      `/webhooks/endpoints/${createdEndpoint.id}/deliveries`,
      {
        headers: {
          'x-user-id': 'admin-user',
          'x-role': 'admin',
          'x-tenant-id': 'tenant-a',
        },
      },
    );
    expect(listDeliveries.status).toBe(200);
    const deliveries = (await listDeliveries.json()) as {
      items: Array<{ status: string; event: string; attempts: number }>;
    };
    expect(deliveries.items.length).toBe(1);
    expect(deliveries.items[0]).toMatchObject({
      status: 'delivered',
      event: 'auth:user.created',
      attempts: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

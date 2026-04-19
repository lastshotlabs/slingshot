import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createWebhooksTestApp } from '../../src/testing';
import type { WebhookDelivery } from '../../src/types/models';
import type { WebhookQueue } from '../../src/types/queue';

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
  events: string[],
): Promise<string> {
  const response = await app.request('/webhooks/endpoints', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: 'https://example.com/hooks/test',
      secret: 'super-secret-token',
      events,
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

describe('webhook plugin delivery lifecycle', () => {
  it('marks non-retryable delivery failures dead after the first attempt', async () => {
    const fetchMock = mock(async () => new Response('bad request', { status: 400 }));
    globalThis.fetch = asFetch(fetchMock);

    const { app, bus, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:user.created'],
      queueConfig: { maxAttempts: 3, retryBaseDelayMs: 1 },
    });

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), ['auth:user.created']);
      bus.emit('auth:user.created', { userId: 'user-1', tenantId: 'tenant-a' });

      const delivery = await waitForDelivery(runtime, endpointId, item => item.status === 'dead');
      expect(delivery.attempts).toBe(1);
      expect(delivery.lastAttempt?.statusCode).toBe(400);
      expect(delivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await teardown();
    }
  });

  it('retries retryable failures until maxAttempts is exhausted', async () => {
    const fetchMock = mock(async () => new Response('upstream error', { status: 500 }));
    globalThis.fetch = asFetch(fetchMock);

    const { app, bus, runtime, teardown } = await createWebhooksTestApp({
      events: ['auth:user.created'],
      queueConfig: { maxAttempts: 2, retryBaseDelayMs: 1 },
    });

    try {
      const endpointId = await createEndpoint(app, adminHeaders(), ['auth:user.created']);
      bus.emit('auth:user.created', { userId: 'user-2', tenantId: 'tenant-a' });

      const delivery = await waitForDelivery(runtime, endpointId, item => item.status === 'dead');
      expect(delivery.attempts).toBe(2);
      expect(delivery.lastAttempt?.statusCode).toBe(500);
      expect(delivery.nextRetryAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await teardown();
    }
  });

  it('marks test deliveries dead when enqueueing fails', async () => {
    const failingQueue: WebhookQueue = {
      name: 'failing',
      enqueue: async () => {
        throw new Error('queue unavailable');
      },
      start: async () => {},
      stop: async () => {},
      depth: async () => 0,
    };

    const { app, runtime, teardown } = await createWebhooksTestApp({
      queue: failingQueue,
      events: ['auth:user.created'],
    });

    try {
      const headers = adminHeaders();
      const endpointId = await createEndpoint(app, headers, ['auth:user.created']);

      const response = await app.request(`/webhooks/endpoints/${endpointId}/test`, {
        method: 'POST',
        headers,
      });

      expect(response.status).toBe(500);

      const delivery = await waitForDelivery(runtime, endpointId, item => item.event === 'webhook:test');
      expect(delivery.status).toBe('dead');
      expect(delivery.lastAttempt?.error).toContain('enqueue failed');
    } finally {
      await teardown();
    }
  });

  it('rejects invalid webhook endpoint URLs and empty event lists', async () => {
    const { app, teardown } = await createWebhooksTestApp({
      events: ['auth:user.created'],
    });

    try {
      const headers = adminHeaders();
      const createResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: 'ftp://example.com/hooks/test',
          secret: 'super-secret-token',
          events: ['auth:user.created'],
        }),
      });

      expect(createResponse.status).toBe(400);
      expect(await createResponse.text()).toContain('Webhook target URL must use http or https');

      const endpointId = await createEndpoint(app, headers, ['auth:user.created']);
      const updateResponse = await app.request(`/webhooks/endpoints/${endpointId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ events: [] }),
      });

      expect(updateResponse.status).toBe(400);
      expect(await updateResponse.text()).toContain('events must not be empty');
    } finally {
      await teardown();
    }
  });
});

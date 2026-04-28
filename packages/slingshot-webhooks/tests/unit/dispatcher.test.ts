import { describe, expect, it, mock } from 'bun:test';
import { deliverWebhook } from '../../src/lib/dispatcher';
import { WebhookDeliveryError } from '../../src/types/queue';
import type { WebhookJob } from '../../src/types/queue';

function makeJob(overrides?: Partial<WebhookJob>): WebhookJob {
  return {
    id: 'job-1',
    deliveryId: 'del-1',
    endpointId: 'ep-1',
    url: 'https://example.com/hook',
    secret: 'test-secret',
    event: 'auth:login',
    eventId: 'evt-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    subscriber: {
      ownerType: 'user',
      ownerId: 'user-1',
      tenantId: 'tenant-a',
    },
    payload: '{"userId":"u1"}',
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

// Cast required at the test boundary: Bun's Mock<() => Response> does not
// structurally overlap with the full typeof fetch signature.
function asFetch(m: ReturnType<typeof mock>): typeof fetch {
  return m as unknown as typeof fetch;
}

const PUBLIC_RESOLVE = async () => [{ address: '8.8.8.8', family: 4 as const }];

describe('deliverWebhook', () => {
  it('sends POST with correct headers on success', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));

    await deliverWebhook(makeJob(), {
      safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
      fetchImpl: asFetch(fetchMock),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers).toHaveProperty('X-Webhook-Signature');
    expect(init.headers).toHaveProperty('X-Webhook-Event', 'auth:login');
    expect(init.headers).toHaveProperty('X-Webhook-Event-Id', 'evt-1');
    expect(init.headers).toHaveProperty('X-Webhook-Occurred-At', '2026-01-01T00:00:00.000Z');
    expect(init.headers).toHaveProperty('X-Webhook-Delivery', 'del-1');
    expect(init.headers).toHaveProperty('Content-Type', 'application/json');
    expect(init.body).toBe('{"userId":"u1"}');
    expect(init.signal).toBeDefined();
  });

  it('throws retryable WebhookDeliveryError on 500', async () => {
    try {
      await deliverWebhook(makeJob(), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(mock(async () => new Response('error', { status: 500 }))),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(true);
      expect((err as WebhookDeliveryError).statusCode).toBe(500);
    }
  });

  it('throws retryable WebhookDeliveryError on 429', async () => {
    try {
      await deliverWebhook(makeJob(), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(mock(async () => new Response('too many', { status: 429 }))),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(true);
      expect((err as WebhookDeliveryError).statusCode).toBe(429);
    }
  });

  it('throws non-retryable WebhookDeliveryError on 400', async () => {
    try {
      await deliverWebhook(makeJob(), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(mock(async () => new Response('bad', { status: 400 }))),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
      expect((err as WebhookDeliveryError).statusCode).toBe(400);
    }
  });

  it('throws non-retryable WebhookDeliveryError on 404', async () => {
    try {
      await deliverWebhook(makeJob(), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(mock(async () => new Response('not found', { status: 404 }))),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
      expect((err as WebhookDeliveryError).statusCode).toBe(404);
    }
  });

  it('does not throw on 200', async () => {
    await expect(
      deliverWebhook(makeJob(), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(mock(async () => new Response('ok', { status: 200 }))),
      }),
    ).resolves.toBeUndefined();
  });
});

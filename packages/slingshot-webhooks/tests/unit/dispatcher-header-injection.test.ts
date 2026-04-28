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
    payload: '{}',
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function asFetch(m: ReturnType<typeof mock>): typeof fetch {
  return m as unknown as typeof fetch;
}

const PUBLIC_RESOLVE = async () => [{ address: '8.8.8.8', family: 4 as const }];

describe('deliverWebhook header sanitization', () => {
  it('rejects CRLF in eventId as non-retryable WebhookDeliveryError', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ eventId: 'evt-1\r\nX-Injected: yes' }), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(fetchMock),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
      expect((err as WebhookDeliveryError).message).toContain('X-Webhook-Event-Id');
    }
    // The forged header must never have reached the wire.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('rejects CRLF in occurredAt without contacting the upstream', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(
        makeJob({ occurredAt: '2026-01-01T00:00:00.000Z\r\nBcc: evil@example.com' }),
        {
          safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
          fetchImpl: asFetch(fetchMock),
        },
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('rejects NUL bytes in deliveryId', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ deliveryId: 'del-1\0evil' }), {
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl: asFetch(fetchMock),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('passes valid headers through unchanged', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    await deliverWebhook(makeJob(), {
      safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
      fetchImpl: asFetch(fetchMock),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toHaveProperty('X-Webhook-Event-Id', 'evt-1');
  });
});

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { deliverWebhook } from '../../src/lib/dispatcher';
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

function asFetch(m: ReturnType<typeof mock>): typeof fetch {
  return m as unknown as typeof fetch;
}

describe('deliverWebhook timeout', () => {
  const originalFetch = globalThis.fetch;
  const originalAbortTimeout = AbortSignal.timeout.bind(AbortSignal);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalAbortTimeout;
  });

  it('uses 30000ms by default when timeoutMs is not provided', async () => {
    const capturedMs: number[] = [];
    AbortSignal.timeout = (ms: number) => {
      capturedMs.push(ms);
      return originalAbortTimeout(ms);
    };
    globalThis.fetch = asFetch(mock(async () => new Response('ok', { status: 200 })));

    await deliverWebhook(makeJob());

    expect(capturedMs).toEqual([30_000]);
  });

  it('uses the provided timeoutMs instead of the default', async () => {
    const capturedMs: number[] = [];
    AbortSignal.timeout = (ms: number) => {
      capturedMs.push(ms);
      return originalAbortTimeout(ms);
    };
    globalThis.fetch = asFetch(mock(async () => new Response('ok', { status: 200 })));

    await deliverWebhook(makeJob(), 5_000);

    expect(capturedMs).toEqual([5_000]);
  });

  it('passes the AbortSignal to fetch', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = asFetch(fetchMock);

    await deliverWebhook(makeJob(), 10_000);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

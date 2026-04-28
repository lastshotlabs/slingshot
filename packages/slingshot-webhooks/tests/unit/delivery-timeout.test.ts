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

const PUBLIC_RESOLVE = async () => [{ address: '8.8.8.8', family: 4 as const }];

describe('deliverWebhook timeout', () => {
  const originalAbortTimeout = AbortSignal.timeout.bind(AbortSignal);

  afterEach(() => {
    AbortSignal.timeout = originalAbortTimeout;
  });

  it('uses 30000ms by default when timeoutMs is not provided', async () => {
    const capturedMs: number[] = [];
    AbortSignal.timeout = (ms: number) => {
      capturedMs.push(ms);
      return originalAbortTimeout(ms);
    };
    const fetchImpl = asFetch(mock(async () => new Response('ok', { status: 200 })));

    await deliverWebhook(makeJob(), {
      safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
      fetchImpl,
    });

    expect(capturedMs).toEqual([30_000]);
  });

  it('uses the provided timeoutMs instead of the default', async () => {
    const capturedMs: number[] = [];
    AbortSignal.timeout = (ms: number) => {
      capturedMs.push(ms);
      return originalAbortTimeout(ms);
    };
    const fetchImpl = asFetch(mock(async () => new Response('ok', { status: 200 })));

    await deliverWebhook(makeJob(), {
      timeoutMs: 5_000,
      safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
      fetchImpl,
    });

    expect(capturedMs).toEqual([5_000]);
  });

  it('passes the AbortSignal to fetch', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));

    await deliverWebhook(makeJob(), {
      timeoutMs: 10_000,
      safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
      fetchImpl: asFetch(fetchMock),
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

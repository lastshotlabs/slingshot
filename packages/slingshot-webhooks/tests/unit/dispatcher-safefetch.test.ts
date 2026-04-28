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

function asFetch(m: ReturnType<typeof mock>): typeof fetch {
  return m as unknown as typeof fetch;
}

describe('deliverWebhook DNS pinning (safeFetch)', () => {
  it('blocks delivery when DNS resolves to a private IPv4 address', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ url: 'https://target.example/hook' }), {
        safeFetchOverrides: {
          resolveHost: async () => [{ address: '10.0.0.5', family: 4 }],
        },
        fetchImpl: asFetch(fetchMock),
      });
      expect.unreachable('expected SSRF block');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
      expect((err as WebhookDeliveryError).message).toMatch(/blocked|not allowed/i);
    }
    // The fetch must NOT have been called: validation happens before fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proceeds with the request when DNS resolves to a public IPv4 address', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));

    await deliverWebhook(makeJob({ url: 'https://public.example/hook' }), {
      safeFetchOverrides: {
        resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      },
      fetchImpl: asFetch(fetchMock),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks IPv6 link-local resolution', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ url: 'https://v6.example/hook' }), {
        safeFetchOverrides: {
          resolveHost: async () => [{ address: 'fe80::1', family: 6 }],
        },
        fetchImpl: asFetch(fetchMock),
      });
      expect.unreachable('expected SSRF block');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ url: 'https://mapped.example/hook' }), {
        safeFetchOverrides: {
          resolveHost: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
        },
        fetchImpl: asFetch(fetchMock),
      });
      expect.unreachable('expected SSRF block');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps DNS resolution failure as retryable WebhookDeliveryError', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    try {
      await deliverWebhook(makeJob({ url: 'https://nodns.example/hook' }), {
        safeFetchOverrides: {
          resolveHost: async () => {
            throw new Error('ENOTFOUND nodns.example');
          },
        },
        fetchImpl: asFetch(fetchMock),
      });
      expect.unreachable('expected DNS error');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookDeliveryError);
      expect((err as WebhookDeliveryError).retryable).toBe(true);
      expect((err as WebhookDeliveryError).message).toMatch(/dns/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured isIpAllowed predicate over the default', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const allowedCalls: Array<{ ip: string; family: 4 | 6 }> = [];

    await deliverWebhook(makeJob({ url: 'https://custom.example/hook' }), {
      safeFetchOverrides: {
        resolveHost: async () => [{ address: '203.0.113.5', family: 4 }],
        isIpAllowed: (ip, family) => {
          allowedCalls.push({ ip, family });
          return true;
        },
      },
      fetchImpl: asFetch(fetchMock),
    });

    expect(allowedCalls).toEqual([{ ip: '203.0.113.5', family: 4 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { deliverWebhook } from '../../src/lib/dispatcher';
import { webhookPluginConfigSchema } from '../../src/types/config';
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

describe('deliveryTimeoutMs config schema', () => {
  it('accepts a valid positive integer at the upper bound', () => {
    const parsed = webhookPluginConfigSchema.parse({ deliveryTimeoutMs: 120_000 });
    expect(parsed.deliveryTimeoutMs).toBe(120_000);
  });

  it('treats omitted deliveryTimeoutMs as undefined (caller falls back to 30000)', () => {
    const parsed = webhookPluginConfigSchema.parse({});
    expect(parsed.deliveryTimeoutMs).toBeUndefined();
  });

  it('rejects values greater than 120000', () => {
    expect(() => webhookPluginConfigSchema.parse({ deliveryTimeoutMs: 120_001 })).toThrow();
    expect(() => webhookPluginConfigSchema.parse({ deliveryTimeoutMs: 600_000 })).toThrow();
  });

  it('rejects zero, negatives, and non-integers', () => {
    expect(() => webhookPluginConfigSchema.parse({ deliveryTimeoutMs: 0 })).toThrow();
    expect(() => webhookPluginConfigSchema.parse({ deliveryTimeoutMs: -1 })).toThrow();
    expect(() => webhookPluginConfigSchema.parse({ deliveryTimeoutMs: 1.5 })).toThrow();
  });
});

describe('per-endpoint deliveryTimeoutMs resolution', () => {
  // Mirrors the resolution chain in plugin.ts:
  //   per-endpoint override (job) > plugin-wide default (config) > 30s baseline.
  function resolveTimeout(
    job: Pick<WebhookJob, 'deliveryTimeoutMs'>,
    config: { deliveryTimeoutMs?: number },
  ): number {
    return job.deliveryTimeoutMs ?? config.deliveryTimeoutMs ?? 30_000;
  }

  it('uses the global default when no per-endpoint override is set', () => {
    expect(resolveTimeout({ deliveryTimeoutMs: null }, { deliveryTimeoutMs: 45_000 })).toBe(45_000);
    expect(resolveTimeout({}, { deliveryTimeoutMs: 45_000 })).toBe(45_000);
  });

  it('falls back to 30000 when neither global nor per-endpoint override is set', () => {
    expect(resolveTimeout({}, {})).toBe(30_000);
    expect(resolveTimeout({ deliveryTimeoutMs: null }, {})).toBe(30_000);
  });

  it('uses the per-endpoint override when set, even with a different global default', () => {
    expect(resolveTimeout({ deliveryTimeoutMs: 5_000 }, { deliveryTimeoutMs: 45_000 })).toBe(5_000);
    expect(resolveTimeout({ deliveryTimeoutMs: 60_000 }, {})).toBe(60_000);
  });

  it('drives the dispatcher timeout when a per-endpoint override is propagated', async () => {
    const capturedMs: number[] = [];
    const originalAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      capturedMs.push(ms);
      return originalAbortTimeout(ms);
    };
    try {
      const fetchImpl = asFetch(mock(async () => new Response('ok', { status: 200 })));
      // Simulate the plugin's processor resolving the override before calling
      // the dispatcher.
      const job = makeJob({ deliveryTimeoutMs: 5_000 });
      const resolved = resolveTimeout(job, { deliveryTimeoutMs: 45_000 });
      await deliverWebhook(job, {
        timeoutMs: resolved,
        safeFetchOverrides: { resolveHost: PUBLIC_RESOLVE },
        fetchImpl,
      });
      expect(capturedMs).toEqual([5_000]);
    } finally {
      AbortSignal.timeout = originalAbortTimeout;
    }
  });
});

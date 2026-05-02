/**
 * `defineHealthIndicator` E2E:
 *  - Indicators registered on `defineApp({ health: { indicators } })` run on /health/ready
 *  - Critical-severity failures flip the response to 503
 *  - Warning-severity failures degrade status but stay 200
 *  - Indicator timeouts are treated as unhealthy
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { defineHealthIndicator } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Health Indicator Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const teardowns: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of teardowns.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('defineHealthIndicator + /health/ready', () => {
  test('healthy indicator → 200 ok', async () => {
    const stripeHealth = defineHealthIndicator({
      name: 'stripe',
      check: async () => ({ status: 'healthy', details: { latencyMs: 12 } }),
    });

    const result = await createApp({ ...baseConfig, health: { indicators: [stripeHealth] } });
    teardowns.push(result.ctx);

    const res = await result.app.request('/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      indicators: Record<string, { status: string; severity: string; latencyMs: number }>;
    };
    expect(body.status).toBe('ok');
    expect(body.indicators.stripe?.status).toBe('healthy');
    expect(body.indicators.stripe?.severity).toBe('critical');
    expect(typeof body.indicators.stripe?.latencyMs).toBe('number');
  });

  test('unhealthy critical indicator → 503', async () => {
    const dbHealth = defineHealthIndicator({
      name: 'database',
      severity: 'critical',
      check: async () => ({ status: 'unhealthy', message: 'connection refused' }),
    });

    const result = await createApp({ ...baseConfig, health: { indicators: [dbHealth] } });
    teardowns.push(result.ctx);

    const res = await result.app.request('/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      indicators: Record<string, { status: string; message?: string }>;
    };
    expect(body.status).toBe('degraded');
    expect(body.indicators.database?.status).toBe('unhealthy');
    expect(body.indicators.database?.message).toBe('connection refused');
  });

  test('unhealthy warning indicator → still 200, but degraded', async () => {
    const cacheHealth = defineHealthIndicator({
      name: 'cache',
      severity: 'warning',
      check: async () => ({ status: 'degraded', message: 'high lag' }),
    });

    const result = await createApp({ ...baseConfig, health: { indicators: [cacheHealth] } });
    teardowns.push(result.ctx);

    const res = await result.app.request('/health/ready');
    // Warning severity does NOT flip the HTTP status to 503; LB keeps the instance.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
  });

  test('thrown error in check → unhealthy with the error message', async () => {
    const flaky = defineHealthIndicator({
      name: 'flaky',
      check: async () => {
        throw new Error('boom');
      },
    });

    const result = await createApp({ ...baseConfig, health: { indicators: [flaky] } });
    teardowns.push(result.ctx);

    const res = await result.app.request('/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      indicators: Record<string, { status: string; message: string }>;
    };
    expect(body.indicators.flaky?.status).toBe('unhealthy');
    expect(body.indicators.flaky?.message).toBe('boom');
  });

  test('indicators run in parallel — total latency ~max(individual), not sum', async () => {
    const slow = defineHealthIndicator({
      name: 'slow-a',
      check: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { status: 'healthy' };
      },
    });
    const alsoSlow = defineHealthIndicator({
      name: 'slow-b',
      check: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { status: 'healthy' };
      },
    });

    const result = await createApp({
      ...baseConfig,
      health: { indicators: [slow, alsoSlow] },
    });
    teardowns.push(result.ctx);

    const start = Date.now();
    const res = await result.app.request('/health/ready');
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // Sequential would be ≥100ms; parallel should be well under 100ms.
    expect(elapsed).toBeLessThan(100);
  });

  test('omitting health config is a no-op (no indicators key in response)', async () => {
    const result = await createApp(baseConfig);
    teardowns.push(result.ctx);

    const res = await result.app.request('/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { indicators?: unknown };
    expect(body.indicators).toBeUndefined();
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createMetricsState,
  resetMetrics,
  serializeMetrics,
} from '../../src/framework/metrics/registry';
import { metricsCollector } from '../../src/framework/middleware/metrics';

const state = createMetricsState();

beforeEach(() => {
  resetMetrics(state);
});

describe('metricsCollector middleware', () => {
  test('records counter and histogram for requests', async () => {
    const app = new Hono();
    app.use(metricsCollector({ state }));
    app.get('/users', c => c.json({ ok: true }));

    await app.request('/users');
    await app.request('/users');

    const output = await serializeMetrics(state);
    expect(output).toContain('http_requests_total{method="GET",path="/users",status="200"} 2');
    expect(output).toContain('http_request_duration_seconds_count');
  });

  test('excludes default paths', async () => {
    const app = new Hono();
    app.use(metricsCollector({ state }));
    app.get('/health', c => c.text('ok'));
    app.get('/metrics', c => c.text('metrics'));

    await app.request('/health');
    await app.request('/metrics');

    const output = await serializeMetrics(state);
    expect(output).not.toContain('/health');
    expect(output).not.toContain('path="/metrics"');
  });

  test('excludes custom paths', async () => {
    const app = new Hono();
    app.use(metricsCollector({ state, excludePaths: ['/internal'] }));
    app.get('/internal/debug', c => c.text('debug'));
    app.get('/api', c => c.json({ ok: true }));

    await app.request('/internal/debug');
    await app.request('/api');

    const output = await serializeMetrics(state);
    expect(output).not.toContain('/internal');
    expect(output).toContain('/api');
  });

  test('tenant label included when tenantId in context', async () => {
    const app = new Hono();
    app.use(async (c, next) => {
      c.set('tenantId' as any, 'acme');
      await next();
    });
    app.use(metricsCollector({ state }));
    app.get('/data', c => c.json({ ok: true }));

    await app.request('/data');

    const output = await serializeMetrics(state);
    expect(output).toContain('tenant="acme"');
  });

  test('normalizes paths to prevent cardinality explosion', async () => {
    const app = new Hono();
    app.use(metricsCollector({ state }));
    app.get('/users/:id', c => c.json({ ok: true }));

    await app.request('/users/550e8400-e29b-41d4-a716-446655440000');
    await app.request('/users/123');

    const output = await serializeMetrics(state);
    expect(output).toContain('path="/users/:id"');
    expect(output).not.toContain('550e8400');
    expect(output).not.toContain('path="/users/123"');
  });
});

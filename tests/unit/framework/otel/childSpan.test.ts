import { trace } from '@opentelemetry/api';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { otelRequestMiddleware } from '../../../../src/framework/middleware/otelRequest';
import { requestId } from '../../../../src/framework/middleware/requestId';
import { createChildSpan } from '../../../../src/framework/otel/spans';

describe('createChildSpan', () => {
  test('returns a span when otelSpan is set on context', async () => {
    const app = new Hono<AppEnv>();
    const tracer = trace.getTracer('test');
    let childSpanDefined = false;

    app.use(requestId);
    app.use(otelRequestMiddleware({ tracer }));
    app.get('/test', c => {
      const child = createChildSpan(c, 'test-child');
      childSpanDefined = child !== undefined;
      child?.end();
      return c.json({ ok: true });
    });

    await app.request('/test');
    expect(childSpanDefined).toBe(true);
  });

  test('returns undefined when otelSpan is not set on context', async () => {
    const app = new Hono<AppEnv>();
    let result: unknown = 'not-checked';

    app.use(requestId);
    app.get('/test', c => {
      result = createChildSpan(c, 'test-child');
      return c.json({ ok: true });
    });

    await app.request('/test');
    expect(result).toBeUndefined();
  });

  test('child span has correct methods', async () => {
    const app = new Hono<AppEnv>();
    const tracer = trace.getTracer('test');
    let hasSetAttribute = false;
    let hasEnd = false;

    app.use(requestId);
    app.use(otelRequestMiddleware({ tracer }));
    app.get('/test', c => {
      const child = createChildSpan(c, 'test-child');
      if (child) {
        hasSetAttribute = typeof child.setAttribute === 'function';
        hasEnd = typeof child.end === 'function';
        child.end();
      }
      return c.json({ ok: true });
    });

    await app.request('/test');
    expect(hasSetAttribute).toBe(true);
    expect(hasEnd).toBe(true);
  });
});

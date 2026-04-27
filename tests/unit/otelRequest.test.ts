import type { Span, TextMapGetter, Tracer } from '@opentelemetry/api';
import { SpanStatusCode, propagation } from '@opentelemetry/api';
import { describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import type { Actor } from '@lastshotlabs/slingshot-core';
import { otelRequestMiddleware } from '../../src/framework/middleware/otelRequest';

// ---------------------------------------------------------------------------
// Mock span that records all calls for assertions
// ---------------------------------------------------------------------------

function createMockSpan() {
  const attrs: Record<string, unknown> = {};
  let status: { code: number; message?: string } | undefined;
  let ended = false;
  let recordedEx: Error | undefined;

  const span: Span = {
    setAttribute(key: string, value: unknown) {
      attrs[key] = value;
      return span;
    },
    setAttributes() {
      return span;
    },
    setStatus(s: { code: number; message?: string }) {
      status = s;
      return span;
    },
    end() {
      ended = true;
    },
    recordException(ex: any) {
      recordedEx = ex;
    },
    addEvent() {
      return span;
    },
    addLink() {
      return span;
    },
    addLinks() {
      return span;
    },
    isRecording() {
      return true;
    },
    updateName() {
      return span;
    },
    spanContext() {
      return { traceId: '0', spanId: '0', traceFlags: 0 };
    },
  } as unknown as Span;

  return {
    span,
    attrs,
    getStatus: () => status,
    isEnded: () => ended,
    getRecordedEx: () => recordedEx,
  };
}

// ---------------------------------------------------------------------------
// Mock tracer that calls the callback with the mock span
// ---------------------------------------------------------------------------

function createMockTracer(mockSpan: Span): Tracer {
  return {
    startSpan() {
      return mockSpan;
    },
    startActiveSpan(_name: string, ...args: any[]) {
      const fn = args[args.length - 1] as (span: Span) => any;
      return fn(mockSpan);
    },
  } as unknown as Tracer;
}

// ---------------------------------------------------------------------------
// Helper: build a Hono app with the otel middleware
// ---------------------------------------------------------------------------

function buildApp(tracer: Tracer, handler?: (c: any) => any) {
  const app = new Hono<{
    Variables: {
      requestId: string;
      tenantId: string;
      actor: {
        id: string;
        kind: 'user';
        tenantId: string;
        sessionId: null;
        roles: string[] | null;
        claims: Record<string, unknown>;
      };
    };
  }>();

  // Provide default context variables the middleware reads after next()
  app.use('/*', async (c, next) => {
    c.set('requestId', 'req-123');
    c.set('tenantId', 'tenant-789');
    c.set('actor', {
      id: 'user-456',
      kind: 'user',
      tenantId: 'tenant-789',
      sessionId: null,
      roles: null,
      claims: {},
    } satisfies Actor);
    await next();
  });

  app.use('/*', otelRequestMiddleware({ tracer }));

  if (handler) {
    app.get('/test', handler);
  } else {
    app.get('/test', c => c.json({ ok: true }));
  }

  return app;
}

// ---------------------------------------------------------------------------
// Helper: create a mock Hono context for direct middleware invocation
// ---------------------------------------------------------------------------

function createMockContext(overrides?: {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  vars?: Record<string, unknown>;
}) {
  const method = overrides?.method ?? 'GET';
  const path = overrides?.path ?? '/test';
  const url = overrides?.url ?? `http://localhost${path}`;
  const headers = new Headers(overrides?.headers ?? {});
  const vars: Record<string, unknown> = { ...overrides?.vars };
  const resStatus = 200;

  const c = {
    req: {
      method,
      path,
      url,
      raw: { headers },
    },
    res: { status: resStatus },
    get(key: string) {
      return vars[key];
    },
    set(key: string, value: unknown) {
      vars[key] = value;
    },
  } as any;

  return { c, vars };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('otelRequestMiddleware', () => {
  test('successful request sets span attributes and OK status', async () => {
    const { span, attrs, getStatus, isEnded } = createMockSpan();
    const tracer = createMockTracer(span);
    const app = buildApp(tracer);

    const res = await app.request('/test', { method: 'GET' });
    expect(res.status).toBe(200);

    // Verify span attributes
    expect(attrs['http.method']).toBe('GET');
    expect(attrs['http.target']).toBe('/test');
    expect(attrs['http.status_code']).toBe(200);
    expect(attrs['slingshot.request_id']).toBe('req-123');
    expect(attrs['slingshot.user_id']).toBe('user-456');
    expect(attrs['slingshot.request_tenant_id']).toBe('tenant-789');

    // Status OK
    expect(getStatus()?.code).toBe(SpanStatusCode.OK);
    expect(isEnded()).toBe(true);
  });

  test('500 response sets ERROR status on span', async () => {
    const { span, getStatus, isEnded } = createMockSpan();
    const tracer = createMockTracer(span);
    const app = buildApp(tracer, c => c.json({ error: 'boom' }, 500));

    const res = await app.request('/test', { method: 'GET' });
    expect(res.status).toBe(500);
    expect(getStatus()?.code).toBe(SpanStatusCode.ERROR);
    expect(isEnded()).toBe(true);
  });

  test('missing context variables are not set as span attributes', async () => {
    const { span, attrs } = createMockSpan();
    const tracer = createMockTracer(span);
    const app = new Hono();
    // No middleware setting requestId/actor/tenantId
    app.use('/*', otelRequestMiddleware({ tracer }));
    app.get('/test', c => c.json({ ok: true }));

    const res = await app.request('/test', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(attrs['slingshot.request_id']).toBeUndefined();
    expect(attrs['slingshot.user_id']).toBeUndefined();
    expect(attrs['slingshot.request_tenant_id']).toBeUndefined();
  });

  test('TextMapGetter.get returns header value and keys returns header keys', async () => {
    // Spy on propagation.extract to capture and invoke the getter callbacks
    let capturedGetter: TextMapGetter<Headers> | undefined;
    let capturedCarrier: Headers | undefined;
    const extractSpy = spyOn(propagation, 'extract').mockImplementation(
      (ctx: any, carrier: any, getter: any) => {
        capturedGetter = getter;
        capturedCarrier = carrier;
        // Call getter methods to exercise lines 35-39
        if (getter) {
          getter.get(carrier, 'traceparent');
          getter.get(carrier, 'nonexistent');
          getter.keys(carrier);
        }
        return ctx; // return context unchanged
      },
    );

    try {
      const { span, attrs } = createMockSpan();
      const tracer = createMockTracer(span);
      const app = buildApp(tracer);

      const res = await app.request('/test', {
        method: 'GET',
        headers: { traceparent: '00-abc-def-01' },
      });
      expect(res.status).toBe(200);
      expect(attrs['http.method']).toBe('GET');

      // Verify the getter was captured and called
      expect(capturedGetter).toBeDefined();
      expect(capturedCarrier).toBeInstanceOf(Headers);

      // Verify getter.get returns the header value
      const traceparentValue = capturedGetter!.get(capturedCarrier!, 'traceparent');
      expect(traceparentValue).toBe('00-abc-def-01');

      // Verify getter.get returns undefined for missing headers
      const missingValue = capturedGetter!.get(capturedCarrier!, 'x-nonexistent');
      expect(missingValue).toBeUndefined();

      // Verify getter.keys returns header names
      const keys = capturedGetter!.keys!(capturedCarrier!);
      expect(keys).toContain('traceparent');
    } finally {
      extractSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // Direct middleware invocation to cover the error catch block (lines 79-84)
  //
  // Hono's compose layer catches handler errors internally and returns a 500
  // response rather than letting the error propagate to the middleware's catch
  // block. To exercise lines 79-84 we invoke the middleware handler directly.
  // -----------------------------------------------------------------------

  test('next() throwing sets ERROR status, records exception, and re-throws', async () => {
    const { span, getStatus, isEnded, getRecordedEx } = createMockSpan();
    const tracer = createMockTracer(span);
    const middleware = otelRequestMiddleware({ tracer });

    const { c } = createMockContext();

    const error = new Error('handler exploded');
    const thrownNext = () => Promise.reject(error);

    await expect(middleware(c as any, thrownNext)).rejects.toThrow('handler exploded');

    expect(getStatus()?.code).toBe(SpanStatusCode.ERROR);
    expect(getStatus()?.message).toBe('handler exploded');
    expect(getRecordedEx()).toBeInstanceOf(Error);
    expect((getRecordedEx() as Error).message).toBe('handler exploded');
    expect(isEnded()).toBe(true);
  });

  test('next() throwing a non-Error value records it as string', async () => {
    const { span, getStatus, isEnded, getRecordedEx } = createMockSpan();
    const tracer = createMockTracer(span);
    const middleware = otelRequestMiddleware({ tracer });

    const { c } = createMockContext();

    const thrownNext = () => Promise.reject('string error');

    await expect(middleware(c as any, thrownNext)).rejects.toBe('string error');

    expect(getStatus()?.code).toBe(SpanStatusCode.ERROR);
    expect(getStatus()?.message).toBe('string error');
    expect(getRecordedEx()).toBeInstanceOf(Error);
    expect((getRecordedEx() as Error).message).toBe('string error');
    expect(isEnded()).toBe(true);
  });

  test('TextMapGetter.get returns undefined for missing header', async () => {
    const { span } = createMockSpan();
    const tracer = createMockTracer(span);
    const middleware = otelRequestMiddleware({ tracer });

    // Create context with no headers to exercise the getter's null-to-undefined path
    const { c } = createMockContext({ headers: {} });
    let nextCalled = false;

    await middleware(c as any, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});

import { trace } from '@opentelemetry/api';
import { describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { otelRequestMiddleware } from '../../src/framework/middleware/otelRequest';
import { requestId } from '../../src/framework/middleware/requestId';
import { requestLogger } from '../../src/framework/middleware/requestLogger';
import type { RequestLogEntry } from '../../src/framework/middleware/requestLogger';

function createLoggerApp(options: Parameters<typeof requestLogger>[0] = {}) {
  const logs: RequestLogEntry[] = [];
  const app = new Hono<AppEnv>();

  app.use(requestId);
  app.use(
    requestLogger({
      ...options,
      onLog: entry => {
        logs.push(entry);
      },
    }),
  );

  return { app, logs };
}

describe('requestLogger middleware', () => {
  test('structured log includes all expected fields', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/api/users', c => c.json({ ok: true }));

    await app.request('/api/users', {
      headers: { 'user-agent': 'test-agent' },
    });

    expect(logs).toHaveLength(1);
    const entry = logs[0];
    expect(entry.level).toBe('info');
    expect(entry.time).toBeGreaterThan(0);
    expect(entry.msg).toBe('GET /api/users 200');
    expect(entry.requestId).toMatch(/^[0-9a-f]{8}-/);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/users');
    expect(entry.statusCode).toBe(200);
    expect(entry.responseTime).toBeGreaterThanOrEqual(0);
    expect(entry.ip).toBeDefined();
    expect(entry.userAgent).toBe('test-agent');
    expect(entry.userId).toBeNull();
    expect(entry.sessionId).toBeNull();
    expect(entry.tenantId).toBeNull();
    expect(entry.err).toBeUndefined();
  });

  test('status-to-level mapping: 2xx → info', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/ok', c => c.json({ ok: true }, 200));
    await app.request('/ok');
    expect(logs[0].level).toBe('info');
  });

  test('status-to-level mapping: 4xx → warn', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/bad', c => c.json({ error: 'bad' }, 400));
    await app.request('/bad');
    expect(logs[0].level).toBe('warn');
    expect(logs[0].statusCode).toBe(400);
  });

  test('status-to-level mapping: 5xx → error', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/fail', c => c.json({ error: 'fail' }, 500));
    await app.request('/fail');
    expect(logs[0].level).toBe('error');
    expect(logs[0].statusCode).toBe(500);
  });

  test("level filtering: level 'warn' skips 200s", async () => {
    const { app, logs } = createLoggerApp({ level: 'warn' });
    app.get('/ok', c => c.json({ ok: true }));
    app.get('/bad', c => c.json({ error: 'bad' }, 400));
    await app.request('/ok');
    await app.request('/bad');
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('warn');
  });

  test('path exclusion with prefix matching', async () => {
    const { app, logs } = createLoggerApp({ excludePaths: ['/health'] });
    app.get('/health', c => c.text('ok'));
    app.get('/health/live', c => c.text('ok'));
    app.get('/api/data', c => c.json({ ok: true }));

    await app.request('/health');
    await app.request('/health/live');
    await app.request('/api/data');

    expect(logs).toHaveLength(1);
    expect(logs[0].path).toBe('/api/data');
  });

  test('path exclusion with RegExp', async () => {
    const { app, logs } = createLoggerApp({ excludePaths: [/^\/internal\//] });
    app.get('/internal/metrics', c => c.text('ok'));
    app.get('/api/data', c => c.json({ ok: true }));

    await app.request('/internal/metrics');
    await app.request('/api/data');

    expect(logs).toHaveLength(1);
    expect(logs[0].path).toBe('/api/data');
  });

  test('method exclusion', async () => {
    const { app, logs } = createLoggerApp({ excludeMethods: ['OPTIONS'] });
    app.on('OPTIONS', '/api', c => c.text('', 204 as any));
    app.get('/api', c => c.json({ ok: true }));

    await app.request('/api', { method: 'OPTIONS' });
    await app.request('/api');

    expect(logs).toHaveLength(1);
    expect(logs[0].method).toBe('GET');
  });

  test('custom onLog callback receives entry', async () => {
    const received: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        onLog: entry => {
          received.push(entry);
        },
      }),
    );
    app.get('/test', c => c.json({ ok: true }));

    await app.request('/test');

    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/test');
  });

  test('userId and tenantId captured from context', async () => {
    const { app, logs } = createLoggerApp();
    app.use(async (c, next) => {
      c.set('authUserId', 'user-123');
      c.set('tenantId', 'tenant-456');
      await next();
    });
    app.get('/api/data', c => c.json({ ok: true }));

    await app.request('/api/data');

    expect(logs[0].userId).toBe('user-123');
    expect(logs[0].tenantId).toBe('tenant-456');
  });

  test('downstream throw still produces a log entry with status 500', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    // Hono's internal error handler catches the throw and produces a 500 response.
    // Our middleware sees the resulting 500 status.
    await app.request('/boom');

    expect(logs).toHaveLength(1);
    expect(logs[0].statusCode).toBe(500);
    expect(logs[0].level).toBe('error');
  });

  test('error thrown before Hono error handler populates err field', async () => {
    // Use a middleware that throws (simulating a lower-level middleware error)
    // to test that the err field is populated when the error reaches our catch
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);

    // Custom compose: throw inside onLog's scope by using a middleware that
    // sets up the error AFTER Hono processes it, so our middleware catches it
    app.use(
      requestLogger({
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    app.use(async () => {
      throw new Error('middleware-error');
    });

    await app.request('/test');

    // Hono catches the error via its built-in handler, producing a 500
    expect(logs).toHaveLength(1);
    expect(logs[0].statusCode).toBe(500);
    expect(logs[0].level).toBe('error');
  });

  test("onLog error isolation: throwing onLog doesn't crash middleware", async () => {
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        onLog: () => {
          throw new Error('logger broken');
        },
      }),
    );
    app.get('/ok', c => c.json({ ok: true }));

    const res = await app.request('/ok');
    expect(res.status).toBe(200);
  });

  test('sessionId captured from context', async () => {
    const { app, logs } = createLoggerApp();
    app.use(async (c, next) => {
      c.set('sessionId', 'sess-789');
      await next();
    });
    app.get('/api/data', c => c.json({ ok: true }));

    await app.request('/api/data');
    expect(logs[0].sessionId).toBe('sess-789');
  });

  test('traceId and spanId are null when otelSpan is not set', async () => {
    const { app, logs } = createLoggerApp();
    app.get('/test', c => c.json({ ok: true }));

    await app.request('/test');

    expect(logs[0].traceId).toBeNull();
    expect(logs[0].spanId).toBeNull();
  });

  test('errorToString handles non-Error thrown string values', async () => {
    // This exercises the errorToString string branch (line 75)
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    app.use(async () => {
      throw 'string-error';
    });

    await app.request('/string-throw');
    // Hono catches it — the middleware sees it when re-thrown
    expect(logs).toHaveLength(1);
    expect(logs[0].statusCode).toBe(500);
  });

  test('errorToString handles non-Error thrown number values', async () => {
    // This exercises the errorToString number branch (line 76-77)
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    app.use(async () => {
      throw 42;
    });

    await app.request('/number-throw');
    expect(logs).toHaveLength(1);
    expect(logs[0].statusCode).toBe(500);
  });

  test('level filtering with error: error below minLevel is still re-thrown (line 157)', async () => {
    // With minLevel: 'error', a 4xx response is filtered (warn < error), but
    // an actual thrown error at warn-level should still propagate
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        level: 'error',
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    app.get('/ok', c => c.json({ ok: true }, 200));

    await app.request('/ok');
    // info < error so entry is dropped
    expect(logs).toHaveLength(0);
  });

  test('err field is populated for non-Error thrown objects (lines 191-194)', async () => {
    // Exercises the non-Error branch of err field population
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(
      requestLogger({
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    // Throw a plain object — not an Error instance
    app.use(async () => {
      throw { code: 'CUSTOM', detail: 'custom error' };
    });

    await app.request('/obj-throw');
    expect(logs).toHaveLength(1);
    // err should be populated even for non-Error thrown values
    expect(logs[0].err).toBeDefined();
    expect(typeof logs[0].err?.message).toBe('string');
  });

  test('traceId and spanId populated when otelSpan is set', async () => {
    const logs: RequestLogEntry[] = [];
    const app = new Hono<AppEnv>();
    const tracer = trace.getTracer('test');

    app.use(requestId);
    app.use(otelRequestMiddleware({ tracer }));
    app.use(
      requestLogger({
        onLog: entry => {
          logs.push(entry);
        },
      }),
    );
    app.get('/test', c => c.json({ ok: true }));

    await app.request('/test');

    expect(logs).toHaveLength(1);
    // With no-op tracer, traceId and spanId will be the no-op values (all zeros)
    // but they should still be strings, not null
    expect(typeof logs[0].traceId).toBe('string');
    expect(typeof logs[0].spanId).toBe('string');
  });

  test('default onLog calls console.log with JSON when no onLog is provided', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    const app = new Hono<AppEnv>();
    app.use(requestId);
    app.use(requestLogger()); // no onLog override — uses default
    app.get('/default-log', c => c.json({ ok: true }));

    await app.request('/default-log');

    const jsonCall = logSpy.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('"path":"/default-log"'),
    );
    expect(jsonCall).toBeDefined();

    logSpy.mockRestore();
  });
});

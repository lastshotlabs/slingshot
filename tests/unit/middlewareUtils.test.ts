import { describe, expect, test } from 'bun:test';
import { applyMiddleware } from '../../src/framework/middleware/index';
import type { Handler, Middleware } from '../../src/framework/middleware/index';
import { logger } from '../../src/framework/middleware/logger';

// ---------------------------------------------------------------------------
// applyMiddleware
// ---------------------------------------------------------------------------

describe('applyMiddleware', () => {
  const baseHandler: Handler = () => new Response('base', { status: 200 });

  test('with no middleware passes the request to the handler unchanged', async () => {
    const handler = applyMiddleware(baseHandler);
    const res = await handler(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('base');
  });

  test('with one middleware wraps the handler', async () => {
    const order: string[] = [];
    const mw: Middleware = async (req, next) => {
      order.push('before');
      const res = await next(req);
      order.push('after');
      return res;
    };
    const handler = applyMiddleware(baseHandler, mw);
    await handler(new Request('http://localhost/'));
    expect(order).toEqual(['before', 'after']);
  });

  test('applies multiple middleware in the correct order (outermost first)', async () => {
    const order: string[] = [];
    const mw1: Middleware = async (req, next) => {
      order.push('mw1-before');
      const res = await next(req);
      order.push('mw1-after');
      return res;
    };
    const mw2: Middleware = async (req, next) => {
      order.push('mw2-before');
      const res = await next(req);
      order.push('mw2-after');
      return res;
    };
    const handler = applyMiddleware(baseHandler, mw1, mw2);
    await handler(new Request('http://localhost/'));
    // mw1 is outermost, mw2 is innermost (just before handler)
    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
  });

  test('middleware can short-circuit by not calling next', async () => {
    const shortCircuit: Middleware = async () => new Response('short', { status: 401 });
    const handler = applyMiddleware(baseHandler, shortCircuit);
    const res = await handler(new Request('http://localhost/'));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('short');
  });

  test('passes the request object to each middleware', async () => {
    const receivedUrls: string[] = [];
    const mw: Middleware = async (req, next) => {
      receivedUrls.push(req.url);
      return next(req);
    };
    const handler = applyMiddleware(baseHandler, mw);
    await handler(new Request('http://localhost/my-path'));
    expect(receivedUrls[0]).toContain('/my-path');
  });
});

// ---------------------------------------------------------------------------
// logger middleware
// ---------------------------------------------------------------------------

describe('logger middleware', () => {
  test('logs method, path, status, and timing then returns the response', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      const handler = applyMiddleware(() => new Response('ok', { status: 200 }), logger);
      const res = await handler(new Request('http://localhost/test-path'));
      expect(res.status).toBe(200);
      expect(logs.length).toBeGreaterThan(0);
      // Format: "METHOD /path STATUS Xms"
      expect(logs[0]).toMatch(/^GET \/test-path 200 \d+\.\d+ms$/);
    } finally {
      console.log = originalLog;
    }
  });

  test('logs the correct HTTP method', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      const handler = applyMiddleware(() => new Response(null, { status: 204 }), logger);
      await handler(new Request('http://localhost/items', { method: 'DELETE' }));
      expect(logs[0]).toMatch(/^DELETE \/items 204/);
    } finally {
      console.log = originalLog;
    }
  });
});

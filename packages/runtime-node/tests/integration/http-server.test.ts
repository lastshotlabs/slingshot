/**
 * Real HTTP integration tests for runtime-node.
 *
 * Starts an actual Node HTTP server via the runtime, sends real HTTP
 * requests using fetch(), and verifies the full round-trip. No mocks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../../src/index';

describe('runtime-node HTTP server integration', () => {
  let stop:
    | ((opts?: boolean | { timeoutMs?: number; closeActiveConnections?: boolean }) => Promise<void>)
    | undefined;
  let port = 0;

  afterEach(async () => {
    if (stop) {
      await stop(true).catch(() => {});
      stop = undefined;
    }
  });

  test('basic GET request returns response with correct status and body', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('hello world'),
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world');
  });

  test('POST with JSON body is received correctly', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async (req: Request) => {
        const body = await req.json();
        return new Response(JSON.stringify({ received: body }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', value: 42 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ received: { name: 'test', value: 42 } });
  });

  test('handler receives request URL, method, and headers', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: (req: Request) => {
        const url = new URL(req.url);
        return new Response(
          JSON.stringify({
            method: req.method,
            path: url.pathname,
            query: url.searchParams.get('q'),
            agent: req.headers.get('user-agent'),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/search?q=hello`, {
      headers: { 'user-agent': 'test-agent' },
    });
    const data = await res.json();
    expect(data.method).toBe('GET');
    expect(data.path).toBe('/search');
    expect(data.query).toBe('hello');
    expect(data.agent).toBe('test-agent');
  });

  test('custom status code and headers on response', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('created', { status: 201, headers: { 'x-custom': 'yes' } }),
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.text()).toBe('created');
  });

  test('server stop(true) releases the port and new server can start', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('first'),
    });
    const p = instance.port;

    const res = await fetch(`http://127.0.0.1:${p}/`);
    expect(await res.text()).toBe('first');
    await instance.stop(true);

    // Start a new server on port 0 (likely gets a different ephemeral port).
    const instance2 = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('second'),
    });
    try {
      const res2 = await fetch(`http://127.0.0.1:${instance2.port}/`);
      expect(await res2.text()).toBe('second');
    } finally {
      await instance2.stop(true);
    }
  });

  test('error callback receives thrown errors and returns custom fallback', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => {
        throw new Error('handler-error');
      },
      error: (err: Error) => new Response(`caught: ${err.message}`, { status: 500 }),
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('caught: handler-error');
  });

  test('large response body (100 KB) is delivered correctly', async () => {
    const largeBody = 'x'.repeat(100 * 1024);
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response(largeBody),
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await res.text();
    expect(text.length).toBe(100 * 1024);
    expect(text).toBe(largeBody);
  });

  test('async fetch handler resolves correctly', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        await new Promise(r => setTimeout(r, 10));
        return new Response('async-result');
      },
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('async-result');
  });

  test('PUT with empty body does not crash', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async (req: Request) => {
        const text = await req.text();
        return new Response(`received:${text.length}`, { status: 200 });
      },
    });
    stop = instance.stop;
    port = instance.port;

    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('received:0');
  });
});

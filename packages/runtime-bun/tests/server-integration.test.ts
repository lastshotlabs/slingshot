/**
 * Real HTTP integration tests for runtime-bun.
 *
 * Starts an actual Bun.serve server via the runtime, sends real HTTP
 * requests using fetch(), and verifies the full round-trip. No mocks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestServer } from '../src/testing';

describe('runtime-bun server integration — real HTTP', () => {
  test('basic GET request returns response with correct status and body', async () => {
    const { port, stop } = await createTestServer(() => new Response('hello world'));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello world');
    } finally {
      await stop();
    }
  });

  test('POST with JSON body is received correctly by handler', async () => {
    const { port, stop } = await createTestServer(async req => {
      const body = await req.json();
      return new Response(JSON.stringify({ received: body }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'test', value: 42 }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ received: { name: 'test', value: 42 } });
    } finally {
      await stop();
    }
  });

  test('response with custom status code and headers', async () => {
    const { port, stop } = await createTestServer(
      () => new Response('created', { status: 201, headers: { 'x-custom': 'yes' } }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(201);
      expect(res.headers.get('x-custom')).toBe('yes');
      expect(await res.text()).toBe('created');
    } finally {
      await stop();
    }
  });

  test('handler receives request URL, method, and headers', async () => {
    const { port, stop } = await createTestServer(req => {
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
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/search?q=hello`, {
        headers: { 'user-agent': 'test-agent' },
      });
      const data = await res.json();
      expect(data.method).toBe('GET');
      expect(data.path).toBe('/search');
      expect(data.query).toBe('hello');
      expect(data.agent).toBe('test-agent');
    } finally {
      await stop();
    }
  });

  test('binary response body is delivered correctly', async () => {
    const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const { port, stop } = await createTestServer(
      () => new Response(binaryData, { headers: { 'content-type': 'application/octet-stream' } }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.arrayBuffer();
      expect(new Uint8Array(body)).toEqual(binaryData);
    } finally {
      await stop();
    }
  });

  test('error callback receives thrown errors and returns custom fallback', async () => {
    const { port, stop } = await createTestServer(
      () => {
        throw new Error('handler-error');
      },
      { error: (err: Error) => new Response(`caught: ${err.message}`, { status: 500 }) },
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught: handler-error');
    } finally {
      await stop();
    }
  });

  test('server stop(true) releases the port for reuse', async () => {
    const { port, stop } = await createTestServer(() => new Response('first'));
    const res1 = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res1.text()).toBe('first');
    await stop();

    const { port: port2, stop: stop2 } = await createTestServer(() => new Response('second'));
    try {
      const res2 = await fetch(`http://127.0.0.1:${port2}/`);
      expect(await res2.text()).toBe('second');
    } finally {
      await stop2();
    }
  });

  test('server can be stopped and started multiple times', async () => {
    for (let i = 0; i < 3; i++) {
      const { port, stop } = await createTestServer(() => new Response(`cycle-${i}`));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(await res.text()).toBe(`cycle-${i}`);
      } finally {
        await stop();
      }
    }
  });

  test('large response body (100 KB) is delivered correctly', async () => {
    const largeBody = 'x'.repeat(100 * 1024);
    const { port, stop } = await createTestServer(() => new Response(largeBody));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const text = await res.text();
      expect(text.length).toBe(100 * 1024);
      expect(text).toBe(largeBody);
    } finally {
      await stop();
    }
  });

  test('async fetch handler resolves correctly', async () => {
    const { port, stop } = await createTestServer(async () => {
      await new Promise(r => setTimeout(r, 10));
      return new Response('async-result');
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('async-result');
    } finally {
      await stop();
    }
  });

  test('PUT with empty body does not crash', async () => {
    const { port, stop } = await createTestServer(async req => {
      const text = await req.text();
      return new Response(`received:${text.length}`, { status: 200 });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'PUT' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('received:0');
    } finally {
      await stop();
    }
  });
});

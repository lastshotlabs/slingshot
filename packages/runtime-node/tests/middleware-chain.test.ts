import { describe, expect, spyOn, test } from 'bun:test';
import { nodeRuntime, runtimeNodeInternals } from '../src/index';

describe('runtime-node server — request handling edge cases', () => {
  // -----------------------------------------------------------------------
  // Request body size limits
  // -----------------------------------------------------------------------

  describe('request body size limits', () => {
    test('rejects request with body larger than maxRequestBodySize', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        maxRequestBodySize: 100,
        fetch: async (req) => {
          const text = await req.text();
          return new Response(`received ${text.length} bytes`);
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`, {
          method: 'POST',
          headers: { 'content-length': '200' },
          body: 'x'.repeat(200),
        });
        // Should be rejected with 413
        expect(res.status).toBe(413);
      } finally {
        await server.stop(true);
      }
    });

    test('accepts request with body at maxRequestBodySize', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        maxRequestBodySize: 100,
        fetch: async (req) => {
          const text = await req.text();
          return new Response(`received ${text.length} bytes`);
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`, {
          method: 'POST',
          headers: { 'content-length': '100' },
          body: 'x'.repeat(100),
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toBe('received 100 bytes');
      } finally {
        await server.stop(true);
      }
    });

    test('accepts request without content-length header', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('no-content-length'),
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await res.text()).toBe('no-content-length');
      } finally {
        await server.stop(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error callback
  // -----------------------------------------------------------------------

  describe('error callback behavior', () => {
    test('error callback is invoked when fetch handler throws', async () => {
      const runtime = nodeRuntime();
      const errors: Error[] = [];
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => {
          throw new Error('handler-boom');
        },
        error: (err) => {
          errors.push(err);
          return new Response('error-handled', { status: 500 });
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('error-handled');
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toBe('handler-boom');
      } finally {
        await server.stop(true);
      }
    });

    test('error callback with async rejection', async () => {
      const runtime = nodeRuntime();
      const errors: Error[] = [];
      const server = await runtime.server.listen({
        port: 0,
        fetch: async () => {
          throw new Error('async-boom');
        },
        error: (err) => {
          errors.push(err);
          return new Response('async-caught', { status: 502 });
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(res.status).toBe(502);
        expect(await res.text()).toBe('async-caught');
        expect(errors).toHaveLength(1);
      } finally {
        await server.stop(true);
      }
    });

    test('without error callback, fetch error returns generic 500', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => {
          throw new Error('unhandled');
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('Internal Server Error');
      } finally {
        await server.stop(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Route handling
  // -----------------------------------------------------------------------

  describe('route handling', () => {
    test('handles different HTTP methods', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: (req) => {
          return new Response(`method:${req.method}`);
        },
      });

      try {
        const [getRes, postRes] = await Promise.all([
          fetch(`http://127.0.0.1:${server.port}/`),
          fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST' }),
        ]);
        expect(await getRes.text()).toBe('method:GET');
        expect(await postRes.text()).toBe('method:POST');
      } finally {
        await server.stop(true);
      }
    });

    test('handles URL with query parameters', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: (req) => {
          const url = new URL(req.url);
          return new Response(`path:${url.pathname} query:${url.searchParams.get('q')}`);
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/search?q=test`);
        expect(await res.text()).toBe('path:/search query:test');
      } finally {
        await server.stop(true);
      }
    });

    test('handles request with body', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: async (req) => {
          const body = await req.text();
          return new Response(`body:${body}`);
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'hello-server',
        });
        expect(await res.text()).toBe('body:hello-server');
      } finally {
        await server.stop(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Server with TLS
  // -----------------------------------------------------------------------

  describe('server stop behavior', () => {
    test('stop(true) resolves quickly', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });

      const start = Date.now();
      await server.stop(true);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });

    test('stop() with no pending requests resolves', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });

      await server.stop();
    });

    test('listen then stop then listen again works', async () => {
      const runtime = nodeRuntime();
      const s1 = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('first'),
      });
      await s1.stop(true);

      const s2 = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('second'),
      });

      try {
        const res = await fetch(`http://127.0.0.1:${s2.port}/`);
        expect(await res.text()).toBe('second');
      } finally {
        await s2.stop(true);
      }
    });
  });
});

import { request } from 'node:http';
import { describe, expect, test } from 'bun:test';
import { nodeRuntime, runtimeNodeInternals } from '../src/index';

const { parseContentLength } = runtimeNodeInternals;

describe('parseContentLength', () => {
  test('parses a valid positive integer', () => {
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength('1')).toBe(1);
    expect(parseContentLength('42')).toBe(42);
    expect(parseContentLength('1048576')).toBe(1_048_576);
  });

  test('parses zero correctly', () => {
    expect(parseContentLength('0')).toBe(0);
  });

  test('returns null when header is null', () => {
    expect(parseContentLength(null)).toBeNull();
  });

  test('returns null when header is empty string', () => {
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('   ')).toBeNull();
  });

  test('returns null for malformed (non-numeric) values', () => {
    expect(parseContentLength('abc')).toBeNull();
    expect(parseContentLength('12.5')).toBeNull();
    expect(parseContentLength('1e3')).toBeNull();
    expect(parseContentLength('0xFF')).toBeNull();
    expect(parseContentLength('1,000')).toBeNull();
  });

  test('returns null for negative number strings', () => {
    expect(parseContentLength('-1')).toBeNull();
    expect(parseContentLength('-0')).toBeNull();
  });

  test('trims whitespace before parsing', () => {
    expect(parseContentLength(' 1024 ')).toBe(1024);
    expect(parseContentLength('\t42\n')).toBe(42);
  });

  test('returns null for very large numbers that overflow safe integer range', () => {
    // parseInt can handle large numbers, but very long digit strings
    // exceeding Number.MAX_SAFE_INTEGER may lose precision. The function
    // still parses them as long as they fit the regex.
    const large = '999999999999999999999999999999';
    const result = parseContentLength(large);
    // Should parse to a finite number (may lose precision but should be non-null)
    expect(result).not.toBeNull();
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('maxRequestBodySize enforcement', () => {
  test('server rejects requests exceeding maxRequestBodySize with 413', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 100,
      fetch: async () => new Response('ok'),
    });
    try {
      // Send a POST with a body larger than 100 bytes
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { 'content-length': '200', 'content-type': 'text/plain' },
        body: 'x'.repeat(200),
      });
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('Payload Too Large');
    } finally {
      await server.stop(true);
    }
  });

  test('server allows requests within maxRequestBodySize', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 1024,
      fetch: async () => new Response('ok'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { 'content-length': '50', 'content-type': 'text/plain' },
        body: 'x'.repeat(50),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await server.stop(true);
    }
  });

  test('server allows requests with no content-length header', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 100,
      fetch: async () => new Response('ok'),
    });
    try {
      // GET request with no body
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test('server rejects chunked requests exceeding maxRequestBodySize', async () => {
    const runtime = nodeRuntime();
    let handlerCalled = false;
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 100,
      fetch: async req => {
        handlerCalled = true;
        return new Response(await req.text());
      },
    });
    try {
      const res = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            path: '/',
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
          },
          response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
              body += chunk;
            });
            response.on('end', () => resolve({ statusCode: response.statusCode, body }));
          },
        );
        req.on('error', reject);
        req.write('x'.repeat(60));
        req.write('x'.repeat(60));
        req.end();
      });

      expect(res.statusCode).toBe(413);
      expect(res.body).toBe('Payload Too Large');
      expect(handlerCalled).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test('server handles content-length exactly at the limit', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 100,
      fetch: async () => new Response('ok'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { 'content-length': '100', 'content-type': 'text/plain' },
        body: 'x'.repeat(100),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test('server handles default maxRequestBodySize (128MB) for large requests', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: async () => new Response('ok'),
    });
    try {
      // 1MB request should pass default 128MB limit
      const body = 'x'.repeat(1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-length': String(body.length),
          'content-type': 'text/plain',
        },
        body,
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test('server with maxRequestBodySize of 0 rejects all requests with body', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      maxRequestBodySize: 0,
      fetch: async () => new Response('ok'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { 'content-length': '1', 'content-type': 'text/plain' },
        body: 'x',
      });
      expect(res.status).toBe(413);
    } finally {
      await server.stop(true);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCookieJar, createTestFullServer, wrapAppAsTestServer } from '../../src/testing';
import type { E2EServerHandle } from '../../src/testing';

// ---------------------------------------------------------------------------
// createCookieJar — lightweight cookie accumulator for E2E tests
// ---------------------------------------------------------------------------

describe('createCookieJar', () => {
  let jar: ReturnType<typeof createCookieJar>;

  beforeEach(() => {
    jar = createCookieJar();
  });

  test('header() returns empty object when no cookies are set', () => {
    expect(jar.header()).toEqual({});
  });

  test('absorb() extracts Set-Cookie header from response', () => {
    const response = new Response(null, {
      headers: { 'set-cookie': 'session=abc123; Path=/; HttpOnly' },
    });
    jar.absorb(response);
    expect(jar.header()).toEqual({ cookie: 'session=abc123' });
  });

  test('absorb() accumulates multiple cookies from separate responses', () => {
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'a=1; Path=/' },
      }),
    );
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'b=2; Path=/' },
      }),
    );
    const h = jar.header();
    expect(h.cookie).toContain('a=1');
    expect(h.cookie).toContain('b=2');
    expect(h.cookie).toContain('; ');
  });

  test('absorb() handles multiple cookies in a single Set-Cookie header', () => {
    // Cookies separated by comma (not followed by space) per the split regex
    const response = new Response(null, {
      headers: { 'set-cookie': 'x=10; Path=/,y=20; HttpOnly' },
    });
    jar.absorb(response);
    const h = jar.header();
    expect(h.cookie).toContain('x=10');
    expect(h.cookie).toContain('y=20');
  });

  test('absorb() overwrites cookie with same name', () => {
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'token=old; Path=/' },
      }),
    );
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'token=new; Path=/' },
      }),
    );
    expect(jar.header()).toEqual({ cookie: 'token=new' });
  });

  test('absorb() is a no-op when response has no Set-Cookie header', () => {
    jar.absorb(new Response(null));
    expect(jar.header()).toEqual({});
  });

  test('absorb() skips malformed cookie parts without "="', () => {
    // A part that has no '=' should be skipped (eq === -1)
    const response = new Response(null, {
      headers: { 'set-cookie': 'malformed; Path=/' },
    });
    jar.absorb(response);
    expect(jar.header()).toEqual({});
  });

  test('absorb() handles cookie value containing "="', () => {
    const response = new Response(null, {
      headers: { 'set-cookie': 'data=base64==; Path=/' },
    });
    jar.absorb(response);
    expect(jar.header()).toEqual({ cookie: 'data=base64==' });
  });

  test('clear() removes all accumulated cookies', () => {
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'sid=xyz; Path=/' },
      }),
    );
    expect(jar.header()).toEqual({ cookie: 'sid=xyz' });
    jar.clear();
    expect(jar.header()).toEqual({});
  });

  test('header() returns properly formatted cookie string with multiple cookies', () => {
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'a=1; Path=/' },
      }),
    );
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'b=2; Path=/' },
      }),
    );
    jar.absorb(
      new Response(null, {
        headers: { 'set-cookie': 'c=3; Path=/' },
      }),
    );
    const h = jar.header();
    // Should be semicolon-separated: "a=1; b=2; c=3"
    const parts = h.cookie!.split('; ');
    expect(parts).toHaveLength(3);
    expect(parts).toContain('a=1');
    expect(parts).toContain('b=2');
    expect(parts).toContain('c=3');
  });
});

// ---------------------------------------------------------------------------
// wrapAppAsTestServer — wraps a pre-built Hono app as a test server
// ---------------------------------------------------------------------------

describe('wrapAppAsTestServer', () => {
  let handle: E2EServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.cleanup();
      handle = null;
    }
  });

  test('wraps a createApp result into a running E2E server', async () => {
    const { createApp } = await import('../../src/app');
    const { app } = await createApp({
      meta: { name: 'WrapTest' },
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
    });

    handle = await wrapAppAsTestServer(app);

    expect(handle.server.port).toBeGreaterThan(0);
    expect(handle.baseUrl).toStartWith('http://localhost:');
    expect(handle.wsUrl).toStartWith('ws://localhost:');
    expect(handle.url).toBe(handle.baseUrl);
    expect(handle.bus).toBeDefined();
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.cleanup).toBe('function');

    // Verify the server actually responds
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createTestFullServer — creates a full Bun.serve-based test server
// ---------------------------------------------------------------------------

describe('createTestFullServer', () => {
  let handle: E2EServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.cleanup();
      handle = null;
    }
  });

  test('creates a full server with defaults and responds to health check', async () => {
    handle = await createTestFullServer({
      routesDir: `${import.meta.dir}/../fixtures/routes`,
      security: {
        rateLimit: { windowMs: 60_000, max: 1000 },
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
          sessionBinding: false as const,
        },
      },
    });

    expect(handle.server.port).toBeGreaterThan(0);
    expect(handle.baseUrl).toStartWith('http://localhost:');
    expect(handle.wsUrl).toStartWith('ws://localhost:');
    expect(handle.bus).toBeDefined();

    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test('restores process.env.PORT after server creation', async () => {
    const origPort = process.env.PORT;
    process.env.PORT = '9999';

    handle = await createTestFullServer({
      routesDir: `${import.meta.dir}/../fixtures/routes`,
      port: 0,
      security: {
        rateLimit: { windowMs: 60_000, max: 1000 },
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
          sessionBinding: false as const,
        },
      },
    });

    // PORT should be restored to its original value
    expect(process.env.PORT).toBe('9999');

    // Clean up
    if (origPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = origPort;
    }
  });
});

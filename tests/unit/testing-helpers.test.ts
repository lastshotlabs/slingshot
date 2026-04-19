import { describe, test, expect, beforeEach } from 'bun:test';
import { createCookieJar } from '../../src/testing';

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

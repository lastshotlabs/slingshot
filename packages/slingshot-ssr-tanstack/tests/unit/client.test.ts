import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fetchSsrLoader, SsrLoaderError } from '../../src/client';

const originalFetch = globalThis.fetch;

function mockFetchOnce(response: Response): void {
  globalThis.fetch = mock(async () => response) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchSsrLoader', () => {
  it('returns `data` from a 200 JSON response', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ data: { profile: { id: 'u1' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const data = await fetchSsrLoader<{ profile: { id: string } }>({
      location: { pathname: '/u/jdd' },
    });
    expect(data.profile.id).toBe('u1');
  });

  it('appends ?_data=1 to opt into JSON-mode', async () => {
    let calledUrl = '';
    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response('{"data":{}}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchSsrLoader({ location: { pathname: '/u/jdd' } });
    expect(calledUrl).toBe('/u/jdd?_data=1');
  });

  it('preserves existing query string and adds &_data=1', async () => {
    let calledUrl = '';
    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response('{"data":{}}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchSsrLoader({
      location: { pathname: '/search', searchStr: '?q=hello' },
    });
    expect(calledUrl).toBe('/search?q=hello&_data=1');
  });

  it('sends Accept: application/json', async () => {
    let sentAccept = '';
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sentAccept = headers.get('accept') ?? '';
      return new Response('{"data":{}}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchSsrLoader({ location: { pathname: '/' } });
    expect(sentAccept).toBe('application/json');
  });

  it('throws SsrLoaderError(404) on { notFound: true }', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ notFound: true }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/u/none' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SsrLoaderError);
    expect((err as SsrLoaderError).status).toBe(404);
  });

  it('throws SsrLoaderError(403) on { forbidden: true }', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ forbidden: true }), {
        status: 403,
      }),
    );
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/admin' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SsrLoaderError);
    expect((err as SsrLoaderError).status).toBe(403);
  });

  it('throws SsrLoaderError(401) on { unauthorized: true }', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ unauthorized: true }), {
        status: 401,
      }),
    );
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/settings' } });
    } catch (e) {
      err = e;
    }
    expect((err as SsrLoaderError).status).toBe(401);
  });

  it('throws SsrLoaderError on a 5xx response', async () => {
    mockFetchOnce(new Response('boom', { status: 503 }));
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/' } });
    } catch (e) {
      err = e;
    }
    expect((err as SsrLoaderError).status).toBe(503);
  });

  it('throws SsrLoaderError on an empty 404 body (no SSR route matched)', async () => {
    mockFetchOnce(new Response('', { status: 404 }));
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/missing' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SsrLoaderError);
    expect((err as SsrLoaderError).status).toBe(404);
    expect((err as SsrLoaderError).message).toContain('empty body');
  });

  it('throws SsrLoaderError on a non-JSON body', async () => {
    mockFetchOnce(
      new Response('<!doctype html><body>not json</body>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    let err: unknown;
    try {
      await fetchSsrLoader({ location: { pathname: '/' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SsrLoaderError);
    expect((err as SsrLoaderError).message).toContain('non-JSON');
  });
});

describe('fetchSsrLoader URL building', () => {
  let calledUrl = '';
  beforeEach(() => {
    calledUrl = '';
    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response('{"data":{}}', { status: 200 });
    }) as unknown as typeof fetch;
  });

  it('handles empty searchStr', async () => {
    await fetchSsrLoader({ location: { pathname: '/x' } });
    expect(calledUrl).toBe('/x?_data=1');
  });

  it('handles searchStr with leading ?', async () => {
    await fetchSsrLoader({ location: { pathname: '/x', searchStr: '?a=1' } });
    expect(calledUrl).toBe('/x?a=1&_data=1');
  });

  it('handles searchStr WITHOUT leading ? (defensive normalisation)', async () => {
    await fetchSsrLoader({ location: { pathname: '/x', searchStr: 'a=1' } });
    expect(calledUrl).toBe('/x?a=1&_data=1');
  });

  it('handles bare ? as searchStr', async () => {
    await fetchSsrLoader({ location: { pathname: '/x', searchStr: '?' } });
    // `/x?&_data=1` is harmless — the empty pair before `&` is tolerated by URL parsers.
    expect(calledUrl).toBe('/x?&_data=1');
  });

  it('handles root pathname', async () => {
    await fetchSsrLoader({ location: { pathname: '/' } });
    expect(calledUrl).toBe('/?_data=1');
  });

  it('falls back to `/` when location is missing', async () => {
    await fetchSsrLoader({});
    expect(calledUrl).toBe('/?_data=1');
  });
});

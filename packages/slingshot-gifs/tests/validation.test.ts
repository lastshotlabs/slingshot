import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createGifsPlugin } from '../src/plugin';
import { createGiphyProvider } from '../src/providers/giphy';
import { createTenorProvider } from '../src/providers/tenor';
import { gifsPluginConfigSchema } from '../src/types';

let fetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

// ---------------------------------------------------------------------------
// Empty upstream arrays
// ---------------------------------------------------------------------------

describe('slingshot-gifs empty upstream responses', () => {
  test('giphy trending returns empty array when upstream returns no data', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = createGiphyProvider({ apiKey: 'key' });
    const results = await provider.trending();

    expect(results).toEqual([]);
  });

  test('tenor search returns empty array when upstream returns no results', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = createTenorProvider({ apiKey: 'key' });
    const results = await provider.search('nonexistent');

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON from upstream
// ---------------------------------------------------------------------------

describe('slingshot-gifs malformed upstream responses', () => {
  test('giphy trending throws on non-JSON response body', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('this is not json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const provider = createGiphyProvider({ apiKey: 'key' });

    await expect(provider.trending()).rejects.toThrow('Giphy trending returned malformed JSON');
  });

  test('tenor search throws on non-JSON response body', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>bad</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const provider = createTenorProvider({ apiKey: 'key' });

    await expect(provider.search('cats')).rejects.toThrow('Tenor search returned malformed JSON');
  });

  test('giphy search throws when data field is missing', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = createGiphyProvider({ apiKey: 'key' });

    await expect(provider.search('wave')).rejects.toThrow(
      'Giphy search response invalid: Response missing "data" array',
    );
  });

  test('tenor trending throws when results field is missing', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = createTenorProvider({ apiKey: 'key' });

    await expect(provider.trending()).rejects.toThrow(
      'Tenor trending response invalid: Response missing "results" array',
    );
  });

  test('giphy throws when a data item is missing required fields', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'gif-1' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const provider = createGiphyProvider({ apiKey: 'key' });

    await expect(provider.trending()).rejects.toThrow(
      'Giphy trending response invalid: data[0] missing "title"',
    );
  });

  test('tenor throws when a result item is missing media_formats', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'tenor-1',
              content_description: 'Test',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const provider = createTenorProvider({ apiKey: 'key' });

    await expect(provider.trending()).rejects.toThrow(
      'Tenor trending response invalid: results[0] missing "media_formats"',
    );
  });
});

// ---------------------------------------------------------------------------
// Timeout behavior
// ---------------------------------------------------------------------------

describe('slingshot-gifs fetch timeout', () => {
  test('giphy throws a timeout error when fetch takes too long', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_input: string | URL | Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // Simulate the AbortController aborting the fetch
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError');
              reject(err);
            });
          }
        });
      },
    );

    const provider = createGiphyProvider({ apiKey: 'key', fetchTimeoutMs: 50 });

    await expect(provider.trending()).rejects.toThrow(
      '[slingshot-gifs] Giphy request timed out after 50ms',
    );
  });

  test('tenor throws a timeout error when fetch takes too long', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_input: string | URL | Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError');
              reject(err);
            });
          }
        });
      },
    );

    const provider = createTenorProvider({ apiKey: 'key', fetchTimeoutMs: 50 });

    await expect(provider.search('cats')).rejects.toThrow(
      '[slingshot-gifs] Tenor request timed out after 50ms',
    );
  });
});

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

describe('slingshot-gifs default config', () => {
  test('schema defaults limit to 25', () => {
    const result = gifsPluginConfigSchema.parse({
      provider: 'giphy',
      apiKey: 'test-key',
    });

    expect(result.limit).toBe(25);
  });

  test('schema defaults mountPath to /gifs', () => {
    const result = gifsPluginConfigSchema.parse({
      provider: 'giphy',
      apiKey: 'test-key',
    });

    expect(result.mountPath).toBe('/gifs');
  });

  test('schema defaults fetchTimeoutMs to 10000', () => {
    const result = gifsPluginConfigSchema.parse({
      provider: 'tenor',
      apiKey: 'test-key',
    });

    expect(result.fetchTimeoutMs).toBe(10_000);
  });

  test('schema rejects empty apiKey', () => {
    const result = gifsPluginConfigSchema.safeParse({
      provider: 'giphy',
      apiKey: '',
    });

    expect(result.success).toBe(false);
  });

  test('schema rejects negative fetchTimeoutMs', () => {
    const result = gifsPluginConfigSchema.safeParse({
      provider: 'giphy',
      apiKey: 'key',
      fetchTimeoutMs: -1,
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenor trending through the route path
// ---------------------------------------------------------------------------

describe('slingshot-gifs tenor trending route', () => {
  test('tenor trending route returns normalized results', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'tenor-1',
              content_description: 'Dance',
              media_formats: {
                gif: {
                  url: 'https://media.example.com/dance.gif',
                  dims: [400, 300],
                },
                tinygif: {
                  url: 'https://media.example.com/dance-tiny.gif',
                  dims: [200, 150],
                },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const app = new Hono();
    const plugin = createGifsPlugin({
      provider: 'tenor',
      apiKey: 'test-tenor-key',
    });

    const emptyObj = {};
    const emptyConfig = emptyObj as never;
    await plugin.setupRoutes?.({
      app: app as never,
      config: emptyConfig,
      bus: createInProcessAdapter(),
    });

    const response = await app.request('/gifs/trending');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        {
          id: 'tenor-1',
          url: 'https://media.example.com/dance.gif',
          preview: 'https://media.example.com/dance-tiny.gif',
          width: 400,
          height: 300,
          title: 'Dance',
        },
      ],
    });
  });

  test('tenor trending route with offset works through the route', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
      const url = new URL(String(input));
      expect(url.searchParams.get('pos')).toBe('5');

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const app = new Hono();
    const plugin = createGifsPlugin({
      provider: 'tenor',
      apiKey: 'test-tenor-key',
    });

    const emptyObj = {};
    const emptyConfig = emptyObj as never;
    await plugin.setupRoutes?.({
      app: app as never,
      config: emptyConfig,
      bus: createInProcessAdapter(),
    });

    const response = await app.request('/gifs/trending?offset=5');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });

  test('tenor trending route rejects negative offset', async () => {
    const app = new Hono();
    const plugin = createGifsPlugin({
      provider: 'tenor',
      apiKey: 'test-tenor-key',
    });

    const emptyObj = {};
    const emptyConfig = emptyObj as never;
    await plugin.setupRoutes?.({
      app: app as never,
      config: emptyConfig,
      bus: createInProcessAdapter(),
    });

    const response = await app.request('/gifs/trending?offset=-1');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "offset" must be a non-negative integer.',
    });
  });
});

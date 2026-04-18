import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createGifsPlugin } from '../src/plugin';
import { resolveGifProvider } from '../src/providers';
import { createGiphyProvider } from '../src/providers/giphy';
import { createTenorProvider } from '../src/providers/tenor';

let fetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

describe('slingshot-gifs providers', () => {
  test('giphy trending applies request params and normalizes payloads', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.giphy.com');
      expect(url.pathname).toBe('/v1/gifs/trending');
      expect(url.searchParams.get('api_key')).toBe('giphy-key');
      expect(url.searchParams.get('limit')).toBe('2');
      expect(url.searchParams.get('offset')).toBe('4');
      expect(url.searchParams.get('rating')).toBe('g');

      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'gif-1',
              title: 'Wave',
              images: {
                original: {
                  url: 'https://cdn.example.com/gif-1.gif',
                  width: '320',
                  height: '180',
                },
                fixed_height: {
                  url: 'https://cdn.example.com/gif-1-preview.gif',
                },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const provider = createGiphyProvider({ apiKey: 'giphy-key', rating: 'pg', limit: 10 });

    await expect(provider.trending({ limit: 2, offset: 4, rating: 'g' })).resolves.toEqual([
      {
        id: 'gif-1',
        url: 'https://cdn.example.com/gif-1.gif',
        preview: 'https://cdn.example.com/gif-1-preview.gif',
        width: 320,
        height: 180,
        title: 'Wave',
      },
    ]);
  });

  test('giphy search surfaces provider failures', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('upstream unavailable', { status: 503, statusText: 'Service Unavailable' }),
    );

    const provider = createGiphyProvider({ apiKey: 'giphy-key' });

    await expect(provider.search('cat jam')).rejects.toThrow(
      '[slingshot-gifs] Giphy search request failed: 503 Service Unavailable',
    );
  });

  test('tenor search applies request params and normalizes payloads', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://tenor.googleapis.com');
      expect(url.pathname).toBe('/v2/search');
      expect(url.searchParams.get('key')).toBe('tenor-key');
      expect(url.searchParams.get('client_key')).toBe('slingshot-gifs');
      expect(url.searchParams.get('limit')).toBe('3');
      expect(url.searchParams.get('pos')).toBe('8');
      expect(url.searchParams.get('contentfilter')).toBe('medium');
      expect(url.searchParams.get('q')).toBe('party parrot');

      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'tenor-1',
              content_description: 'Party parrot',
              media_formats: {
                gif: {
                  url: 'https://media.example.com/party-parrot.gif',
                  dims: [480, 270],
                },
                tinygif: {
                  url: 'https://media.example.com/party-parrot-tiny.gif',
                  dims: [220, 124],
                },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const provider = createTenorProvider({ apiKey: 'tenor-key', rating: 'low', limit: 12 });

    await expect(
      provider.search('party parrot', { limit: 3, offset: 8, rating: 'medium' }),
    ).resolves.toEqual([
      {
        id: 'tenor-1',
        url: 'https://media.example.com/party-parrot.gif',
        preview: 'https://media.example.com/party-parrot-tiny.gif',
        width: 480,
        height: 270,
        title: 'Party parrot',
      },
    ]);
  });

  test('tenor trending surfaces provider failures', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );

    const provider = createTenorProvider({ apiKey: 'tenor-key' });

    await expect(provider.trending()).rejects.toThrow(
      '[slingshot-gifs] Tenor featured request failed: 429 Too Many Requests',
    );
  });

  test('plugin search route honors mountPath and forwards numeric offset', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v2/search');
      expect(url.searchParams.get('q')).toBe('wave');
      expect(url.searchParams.get('pos')).toBe('12');
      expect(url.searchParams.get('limit')).toBe('7');
      expect(url.searchParams.get('contentfilter')).toBe('medium');

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const app = new Hono();
    const plugin = createGifsPlugin({
      provider: 'tenor',
      apiKey: 'tenor-key',
      mountPath: '/media/gifs',
      limit: 7,
      rating: 'medium',
    });

    await plugin.setupRoutes?.({
      app: app as never,
      config: {} as never,
      bus: createInProcessAdapter(),
    });

    const response = await app.request('/media/gifs/search?q=wave&offset=12');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });

  test('resolveGifProvider rejects unknown providers loudly', () => {
    expect(() =>
      resolveGifProvider({
        provider: 'unknown' as never,
        apiKey: 'x',
        limit: 25,
        mountPath: '/gifs',
      }),
    ).toThrow('Unknown GIF provider "unknown"');
  });
});

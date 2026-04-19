import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createGifsPlugin } from '../src/plugin';

let fetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

async function bootGifsApp() {
  const app = new Hono();
  const plugin = createGifsPlugin({
    provider: 'giphy',
    apiKey: 'test-api-key',
  });
  const emptyConfig: never = {} as never;
  await plugin.setupRoutes?.({
    app: app as never,
    config: emptyConfig,
    bus: createInProcessAdapter(),
  });
  return app;
}

describe('slingshot-gifs smoke', () => {
  test('normalizes a giphy trending response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
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
      ),
    );

    const app = await bootGifsApp();
    const response = await app.request('/gifs/trending');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        {
          id: 'gif-1',
          url: 'https://cdn.example.com/gif-1.gif',
          preview: 'https://cdn.example.com/gif-1-preview.gif',
          width: 320,
          height: 180,
          title: 'Wave',
        },
      ],
    });
  });

  test('requires a search query', async () => {
    const app = await bootGifsApp();
    const response = await app.request('/gifs/search');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "q" is required.',
    });
  });

  test('rejects invalid offset values before calling the upstream provider', async () => {
    const app = await bootGifsApp();
    fetchSpy = spyOn(globalThis, 'fetch');

    const response = await app.request('/gifs/search?q=wave&offset=not-a-number');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "offset" must be a non-negative integer.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects mountPath values that do not start with a slash', () => {
    expect(() =>
      createGifsPlugin({
        provider: 'giphy',
        apiKey: 'test-api-key',
        mountPath: 'gifs',
      }),
    ).toThrow();
  });
});

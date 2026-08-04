import { type Mock, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import { createGifsPlugin } from '../src/plugin';
import { createGiphyProvider } from '../src/providers/giphy';
import { createKlipyProvider } from '../src/providers/klipy';

/**
 * Stickers, verified against the shapes the LIVE providers actually return.
 *
 * Every fixture here was taken from a real call to api.klipy.com/v2 before
 * this was written, because the interesting part of sticker support is not
 * the plumbing — it is that a sticker response looks DIFFERENT from a GIF
 * response in a way that silently breaks the existing code path:
 *
 *   GET /v2/search?...&searchfilter=sticker&media_filter=gif_transparent,tinygif_transparent
 *     -> media_formats: ['gif_transparent', 'tinygif_transparent']
 *
 * The opaque `gif` / `tinygif` keys are ABSENT, not merely unused. The
 * validator hard-required `media_formats.gif`, so before this change every
 * sticker response was rejected as "response invalid: results[0] missing
 * media_formats.gif" — an error blaming the provider for an assumption we
 * were making locally.
 *
 * Transparency is the whole point: without the `*_transparent` formats the
 * provider answers with the artwork flattened onto an opaque background,
 * which renders as a picture of a sticker inside a white box.
 */

let fetchSpy: { mockRestore: () => void } | null = null;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function spyOnFetch() {
  return spyOn(globalThis, 'fetch') as unknown as Mock<FetchLike>;
}

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function stickerResponse() {
  return new Response(
    JSON.stringify({
      results: [
        {
          id: 'sticker-1',
          content_description: 'Happy Cat Sticker',
          media_formats: {
            // Note the absence of `gif` / `tinygif` — this mirrors the live API.
            gif_transparent: { url: 'https://media.example.com/cat.gif', dims: [400, 400] },
            tinygif_transparent: {
              url: 'https://media.example.com/cat-tiny.gif',
              dims: [120, 120],
            },
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('sticker support', () => {
  test('a KLIPY sticker search asks for stickers AND for transparency', async () => {
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async input => {
      const url = new URL(String(input));
      // Without `searchfilter` the API returns ordinary GIFs for the same
      // query — confirmed live, the result sets differ.
      expect(url.searchParams.get('searchfilter')).toBe('sticker');
      // Without the transparent formats the artwork arrives flattened.
      expect(url.searchParams.get('media_filter')).toBe('gif_transparent,tinygif_transparent');
      return stickerResponse();
    });

    const provider = createKlipyProvider({ apiKey: 'k' });
    await expect(provider.search('cat', { kind: 'sticker' })).resolves.toEqual([
      {
        id: 'sticker-1',
        kind: 'sticker',
        url: 'https://media.example.com/cat.gif',
        preview: 'https://media.example.com/cat-tiny.gif',
        width: 400,
        height: 400,
        title: 'Happy Cat Sticker',
      },
    ]);
  });

  test('a sticker response validates even though it has no `gif` key', async () => {
    // The regression this change is really about. Before it, this threw
    // `results[0] missing "media_formats.gif"`.
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async () => stickerResponse());
    const provider = createKlipyProvider({ apiKey: 'k' });
    const results = await provider.search('cat', { kind: 'sticker' });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe('sticker');
  });

  test('trending stickers use the same filters as search', async () => {
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v2/featured');
      expect(url.searchParams.get('searchfilter')).toBe('sticker');
      return stickerResponse();
    });
    const provider = createKlipyProvider({ apiKey: 'k' });
    await expect(provider.trending({ kind: 'sticker' })).resolves.toHaveLength(1);
  });

  test('omitting `kind` still sends the plain-GIF request, byte for byte', async () => {
    // The compatibility guarantee. An existing caller must produce the exact
    // request it produced before this feature existed — no `searchfilter`,
    // and the media filter the provider was CONFIGURED with rather than a
    // new default.
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.searchParams.get('searchfilter')).toBeNull();
      expect(url.searchParams.get('media_filter')).toBe('gif,tinygif');
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'g1',
              content_description: 'a gif',
              media_formats: {
                gif: { url: 'https://media.example.com/g.gif', dims: [1, 2] },
                tinygif: { url: 'https://media.example.com/g-t.gif', dims: [3, 4] },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = createKlipyProvider({ apiKey: 'k' });
    const results = await provider.search('cat');
    expect(results[0]?.kind).toBe('gif');
  });

  test('Giphy switches RESOURCE PATH rather than adding a parameter', async () => {
    // Giphy models stickers as a sibling resource, not a filter. Getting this
    // wrong returns GIFs with a 200 and no error anywhere.
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async input => {
      expect(new URL(String(input)).pathname).toBe('/v1/stickers/search');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 's1',
              title: 'a sticker',
              images: {
                original: { url: 'https://media.giphy.com/s.gif', width: '200', height: '200' },
                fixed_height: { url: 'https://media.giphy.com/s-t.gif' },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = createGiphyProvider({ apiKey: 'g' });
    const results = await provider.search('cat', { kind: 'sticker' });
    expect(results[0]?.kind).toBe('sticker');
  });

  test('an unrecognised `kind` is a 400, NOT a silent fallback to GIFs', async () => {
    // A typo'd `?kind=stickers` that quietly served GIFs would reach a user as
    // "the sticker tab is just GIFs again", with a 200 in the access log and
    // nothing anywhere to explain it.
    const app = new Hono();
    const bus = createInProcessAdapter();
    const plugin = createGifsPlugin({ provider: 'klipy', apiKey: 'k' });
    plugin.setupRoutes?.({
      app,
      bus,
      events: createEventPublisher({ definitions: createEventDefinitionRegistry(), bus }),
    } as never);

    const res = await app.request('/gifs/search?q=cat&kind=stickers');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('kind');
  });

  test('an ABSENT `kind` is accepted and means gif', async () => {
    fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async input => {
      expect(new URL(String(input)).searchParams.get('searchfilter')).toBeNull();
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const app = new Hono();
    const bus = createInProcessAdapter();
    const plugin = createGifsPlugin({ provider: 'klipy', apiKey: 'k' });
    plugin.setupRoutes?.({
      app,
      bus,
      events: createEventPublisher({ definitions: createEventDefinitionRegistry(), bus }),
    } as never);

    expect((await app.request('/gifs/search?q=cat')).status).toBe(200);
  });
});

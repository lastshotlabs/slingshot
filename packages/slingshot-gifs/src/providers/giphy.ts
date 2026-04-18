import type { GifProvider, GifResult, GifSearchOptions } from '../types';

/** Shape of a single item in the Giphy API `data` array. */
interface GiphyGif {
  id: string;
  title: string;
  images: {
    original: { url: string; width: string; height: string };
    fixed_height: { url: string };
  };
}

/** Top-level Giphy API response envelope. */
interface GiphyResponse {
  data: GiphyGif[];
}

/**
 * Map a raw Giphy API item to the normalized {@link GifResult} shape.
 */
function mapGiphyGif(g: GiphyGif): GifResult {
  return {
    id: g.id,
    url: g.images.original.url,
    preview: g.images.fixed_height.url,
    width: Number(g.images.original.width),
    height: Number(g.images.original.height),
    title: g.title,
  };
}

/**
 * Create a Giphy-backed {@link GifProvider}.
 *
 * The API key is closure-owned and never exposed in responses.
 * All HTTP calls use the global `fetch()` provided by Bun.
 *
 * @param config - Provider-level configuration (apiKey, rating, limit).
 * @returns A `GifProvider` that delegates to the Giphy v1 API.
 */
export function createGiphyProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
}): GifProvider {
  const { apiKey, rating, limit = 25 } = config;
  const baseUrl = 'https://api.giphy.com/v1/gifs';

  function buildParams(opts?: GifSearchOptions): URLSearchParams {
    const params = new URLSearchParams();
    params.set('api_key', apiKey);
    params.set('limit', String(opts?.limit ?? limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const r = opts?.rating ?? rating;
    if (r) params.set('rating', r);
    return params;
  }

  return {
    name: 'giphy',

    async trending(opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      const res = await fetch(`${baseUrl}/trending?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Giphy trending request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as GiphyResponse;
      return body.data.map(mapGiphyGif);
    },

    async search(query: string, opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      params.set('q', query);
      const res = await fetch(`${baseUrl}/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Giphy search request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as GiphyResponse;
      return body.data.map(mapGiphyGif);
    },
  };
}

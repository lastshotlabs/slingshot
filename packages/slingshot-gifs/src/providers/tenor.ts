import type { GifProvider, GifResult, GifSearchOptions } from '../types';

/** Shape of a single item in the Tenor API v2 `results` array. */
interface TenorGif {
  id: string;
  content_description: string;
  media_formats: {
    gif: { url: string; dims: [number, number] };
    tinygif: { url: string; dims: [number, number] };
  };
}

/** Top-level Tenor API v2 response envelope. */
interface TenorResponse {
  results: TenorGif[];
}

/**
 * Map a raw Tenor API item to the normalized {@link GifResult} shape.
 */
function mapTenorGif(g: TenorGif): GifResult {
  return {
    id: g.id,
    url: g.media_formats.gif.url,
    preview: g.media_formats.tinygif.url,
    width: g.media_formats.gif.dims[0],
    height: g.media_formats.gif.dims[1],
    title: g.content_description,
  };
}

/**
 * Create a Tenor-backed {@link GifProvider}.
 *
 * The API key is closure-owned and never exposed in responses.
 * All HTTP calls use the global `fetch()` provided by Bun.
 *
 * Tenor v2 uses `key` for the API key and `client_key` for app identification.
 * This provider sets `client_key` to `'slingshot-gifs'`.
 *
 * @param config - Provider-level configuration (apiKey, rating, limit).
 * @returns A `GifProvider` that delegates to the Tenor v2 API.
 */
export function createTenorProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
}): GifProvider {
  const { apiKey, rating, limit = 25 } = config;
  const baseUrl = 'https://tenor.googleapis.com/v2';

  function buildParams(opts?: GifSearchOptions): URLSearchParams {
    const params = new URLSearchParams();
    params.set('key', apiKey);
    params.set('client_key', 'slingshot-gifs');
    params.set('limit', String(opts?.limit ?? limit));
    if (opts?.offset !== undefined) params.set('pos', String(opts.offset));
    const r = opts?.rating ?? rating;
    if (r) params.set('contentfilter', r);
    return params;
  }

  return {
    name: 'tenor',

    async trending(opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      const res = await fetch(`${baseUrl}/featured?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Tenor featured request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as TenorResponse;
      return body.results.map(mapTenorGif);
    },

    async search(query: string, opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      params.set('q', query);
      const res = await fetch(`${baseUrl}/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Tenor search request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as TenorResponse;
      return body.results.map(mapTenorGif);
    },
  };
}

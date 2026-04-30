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
 * Validate that a parsed JSON value matches the expected Tenor response shape.
 *
 * Returns `null` when the shape is valid, or an error message describing what
 * is wrong.
 */
function validateTenorResponse(body: unknown): string | null {
  if (body == null || typeof body !== 'object') {
    return 'Response is not an object';
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.results)) {
    return 'Response missing "results" array';
  }
  for (let i = 0; i < obj.results.length; i++) {
    const item = obj.results[i] as Record<string, unknown>;
    if (typeof item.id !== 'string') return `results[${i}] missing "id"`;
    if (typeof item.content_description !== 'string')
      return `results[${i}] missing "content_description"`;
    const formats = item.media_formats as Record<string, unknown> | undefined;
    if (formats == null || typeof formats !== 'object')
      return `results[${i}] missing "media_formats"`;
    const gif = formats.gif as Record<string, unknown> | undefined;
    if (gif == null || typeof gif !== 'object') return `results[${i}] missing "media_formats.gif"`;
    if (typeof gif.url !== 'string') return `results[${i}] missing "media_formats.gif.url"`;
    if (!Array.isArray(gif.dims) || gif.dims.length < 2)
      return `results[${i}] missing "media_formats.gif.dims"`;
    const tinygif = formats.tinygif as Record<string, unknown> | undefined;
    if (tinygif == null || typeof tinygif !== 'object')
      return `results[${i}] missing "media_formats.tinygif"`;
    if (typeof tinygif.url !== 'string') return `results[${i}] missing "media_formats.tinygif.url"`;
    if (!Array.isArray(tinygif.dims) || tinygif.dims.length < 2)
      return `results[${i}] missing "media_formats.tinygif.dims"`;
  }
  return null;
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
 * @param config - Provider-level configuration (apiKey, rating, limit, fetchTimeoutMs).
 * @returns A `GifProvider` that delegates to the Tenor v2 API.
 */
export function createTenorProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
  fetchTimeoutMs?: number;
}): GifProvider {
  const { apiKey, rating, limit = 25, fetchTimeoutMs = 10_000 } = config;
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

  async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`[slingshot-gifs] Tenor request timed out after ${fetchTimeoutMs}ms`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseAndValidate(res: Response, label: string): Promise<TenorResponse> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`[slingshot-gifs] Tenor ${label} returned malformed JSON`);
    }
    const validationError = validateTenorResponse(body);
    if (validationError != null) {
      throw new Error(`[slingshot-gifs] Tenor ${label} response invalid: ${validationError}`);
    }
    return body as TenorResponse;
  }

  return {
    name: 'tenor',

    async trending(opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      const res = await fetchWithTimeout(`${baseUrl}/featured?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Tenor featured request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = await parseAndValidate(res, 'trending');
      return body.results.map(mapTenorGif);
    },

    async search(query: string, opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      params.set('q', query);
      const res = await fetchWithTimeout(`${baseUrl}/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Tenor search request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = await parseAndValidate(res, 'search');
      return body.results.map(mapTenorGif);
    },
  };
}

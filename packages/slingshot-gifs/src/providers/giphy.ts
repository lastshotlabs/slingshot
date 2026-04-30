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
 * Validate that a parsed JSON value matches the expected Giphy response shape.
 *
 * Returns `null` when the shape is valid, or an error message describing what
 * is wrong.
 */
function validateGiphyResponse(body: unknown): string | null {
  if (body == null || typeof body !== 'object') {
    return 'Response is not an object';
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.data)) {
    return 'Response missing "data" array';
  }
  for (let i = 0; i < obj.data.length; i++) {
    const item = obj.data[i] as Record<string, unknown>;
    if (typeof item.id !== 'string') return `data[${i}] missing "id"`;
    if (typeof item.title !== 'string') return `data[${i}] missing "title"`;
    const images = item.images as Record<string, unknown> | undefined;
    if (images == null || typeof images !== 'object') return `data[${i}] missing "images"`;
    const original = images.original as Record<string, unknown> | undefined;
    if (original == null || typeof original !== 'object')
      return `data[${i}] missing "images.original"`;
    if (typeof original.url !== 'string') return `data[${i}] missing "images.original.url"`;
    if (typeof original.width !== 'string') return `data[${i}] missing "images.original.width"`;
    if (typeof original.height !== 'string') return `data[${i}] missing "images.original.height"`;
    const fixedHeight = images.fixed_height as Record<string, unknown> | undefined;
    if (fixedHeight == null || typeof fixedHeight !== 'object')
      return `data[${i}] missing "images.fixed_height"`;
    if (typeof fixedHeight.url !== 'string') return `data[${i}] missing "images.fixed_height.url"`;
  }
  return null;
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
 * @param config - Provider-level configuration (apiKey, rating, limit, fetchTimeoutMs).
 * @returns A `GifProvider` that delegates to the Giphy v1 API.
 */
export function createGiphyProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
  fetchTimeoutMs?: number;
}): GifProvider {
  const { apiKey, rating, limit = 25, fetchTimeoutMs = 10_000 } = config;
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

  async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`[slingshot-gifs] Giphy request timed out after ${fetchTimeoutMs}ms`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseAndValidate(res: Response, label: string): Promise<GiphyResponse> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`[slingshot-gifs] Giphy ${label} returned malformed JSON`);
    }
    const validationError = validateGiphyResponse(body);
    if (validationError != null) {
      throw new Error(`[slingshot-gifs] Giphy ${label} response invalid: ${validationError}`);
    }
    return body as GiphyResponse;
  }

  return {
    name: 'giphy',

    async trending(opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      const res = await fetchWithTimeout(`${baseUrl}/trending?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Giphy trending request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = await parseAndValidate(res, 'trending');
      return body.data.map(mapGiphyGif);
    },

    async search(query: string, opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      params.set('q', query);
      const res = await fetchWithTimeout(`${baseUrl}/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          `[slingshot-gifs] Giphy search request failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = await parseAndValidate(res, 'search');
      return body.data.map(mapGiphyGif);
    },
  };
}

import type { GifProvider, GifResult, GifSearchOptions } from '../types';

/** Shape shared by Tenor v2 and KLIPY's Tenor-compatible v2 API. */
interface TenorCompatibleGif {
  id: string;
  content_description: string;
  media_formats: {
    gif: { url: string; dims: [number, number] };
    tinygif: { url: string; dims: [number, number] };
  };
}

interface TenorCompatibleResponse {
  results: TenorCompatibleGif[];
}

interface TenorCompatibleProviderConfig {
  providerName: string;
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  rating?: string;
  limit?: number;
  fetchTimeoutMs?: number;
  mediaFilter?: string;
}

function validateResponse(body: unknown): string | null {
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
    if (typeof item.content_description !== 'string') {
      return `results[${i}] missing "content_description"`;
    }
    const formats = item.media_formats as Record<string, unknown> | undefined;
    if (formats == null || typeof formats !== 'object') {
      return `results[${i}] missing "media_formats"`;
    }
    const gif = formats.gif as Record<string, unknown> | undefined;
    if (gif == null || typeof gif !== 'object') return `results[${i}] missing "media_formats.gif"`;
    if (typeof gif.url !== 'string') return `results[${i}] missing "media_formats.gif.url"`;
    if (!Array.isArray(gif.dims) || gif.dims.length < 2) {
      return `results[${i}] missing "media_formats.gif.dims"`;
    }
    const tinygif = formats.tinygif as Record<string, unknown> | undefined;
    if (tinygif == null || typeof tinygif !== 'object') {
      return `results[${i}] missing "media_formats.tinygif"`;
    }
    if (typeof tinygif.url !== 'string') {
      return `results[${i}] missing "media_formats.tinygif.url"`;
    }
    if (!Array.isArray(tinygif.dims) || tinygif.dims.length < 2) {
      return `results[${i}] missing "media_formats.tinygif.dims"`;
    }
  }
  return null;
}

function mapGif(gif: TenorCompatibleGif): GifResult {
  return {
    id: gif.id,
    url: gif.media_formats.gif.url,
    preview: gif.media_formats.tinygif.url,
    width: gif.media_formats.gif.dims[0],
    height: gif.media_formats.gif.dims[1],
    title: gif.content_description,
  };
}

/** Construct a provider backed by a Tenor-v2-compatible HTTP API. */
export function createTenorCompatibleProvider(config: TenorCompatibleProviderConfig): GifProvider {
  const {
    providerName,
    providerLabel,
    baseUrl,
    apiKey,
    rating,
    limit = 25,
    fetchTimeoutMs = 10_000,
    mediaFilter,
  } = config;

  function buildParams(opts?: GifSearchOptions): URLSearchParams {
    const params = new URLSearchParams();
    params.set('key', apiKey);
    params.set('client_key', 'slingshot-gifs');
    params.set('limit', String(opts?.limit ?? limit));
    if (opts?.offset !== undefined) params.set('pos', String(opts.offset));
    const contentFilter = opts?.rating ?? rating;
    if (contentFilter) params.set('contentfilter', contentFilter);
    if (mediaFilter) params.set('media_filter', mediaFilter);
    return params;
  }

  async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `[slingshot-gifs] ${providerLabel} request timed out after ${fetchTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseAndValidate(
    response: Response,
    label: string,
  ): Promise<TenorCompatibleResponse> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`[slingshot-gifs] ${providerLabel} ${label} returned malformed JSON`);
    }
    const validationError = validateResponse(body);
    if (validationError != null) {
      throw new Error(
        `[slingshot-gifs] ${providerLabel} ${label} response invalid: ${validationError}`,
      );
    }
    return body as TenorCompatibleResponse;
  }

  return {
    name: providerName,

    async trending(opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      const response = await fetchWithTimeout(`${baseUrl}/featured?${params.toString()}`);
      if (!response.ok) {
        throw new Error(
          `[slingshot-gifs] ${providerLabel} featured request failed: ${response.status} ${response.statusText}`,
        );
      }
      const body = await parseAndValidate(response, 'trending');
      return body.results.map(mapGif);
    },

    async search(query: string, opts?: GifSearchOptions): Promise<GifResult[]> {
      const params = buildParams(opts);
      params.set('q', query);
      const response = await fetchWithTimeout(`${baseUrl}/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(
          `[slingshot-gifs] ${providerLabel} search request failed: ${response.status} ${response.statusText}`,
        );
      }
      const body = await parseAndValidate(response, 'search');
      return body.results.map(mapGif);
    },
  };
}

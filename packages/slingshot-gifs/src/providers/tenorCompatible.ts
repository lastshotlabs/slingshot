import type { GifProvider, GifResult, GifSearchOptions, MediaKind } from '../types';

/** Shape shared by Tenor v2 and KLIPY's Tenor-compatible v2 API. */
interface TenorCompatibleGif {
  id: string;
  content_description: string;
  media_formats: Record<string, { url: string; dims: [number, number] }>;
}

/**
 * The `media_formats` keys a response carries depend on the kind requested.
 *
 * Stickers come back under `gif_transparent` / `tinygif_transparent` and do
 * NOT include the opaque `gif` / `tinygif` keys at all — so a validator that
 * hard-requires `media_formats.gif` rejects every sticker response as
 * malformed. Verified against the live KLIPY v2 API: a sticker search returns
 * exactly `['gif_transparent', 'tinygif_transparent']` and nothing else.
 */
const FORMAT_KEYS: Record<MediaKind, { full: string; preview: string }> = {
  gif: { full: 'gif', preview: 'tinygif' },
  sticker: { full: 'gif_transparent', preview: 'tinygif_transparent' },
};

/**
 * Media filters requested per kind.
 *
 * Asking for the transparent formats is what actually makes a sticker a
 * sticker. Without it the provider answers with flattened artwork on an
 * opaque background, which renders as a picture of a sticker in a white box.
 */
const MEDIA_FILTERS: Record<MediaKind, string> = {
  gif: 'gif,tinygif',
  sticker: 'gif_transparent,tinygif_transparent',
};

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

function validateResponse(body: unknown, kind: MediaKind): string | null {
  const { full, preview } = FORMAT_KEYS[kind];
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
    const gif = formats[full] as Record<string, unknown> | undefined;
    if (gif == null || typeof gif !== 'object') {
      return `results[${i}] missing "media_formats.${full}"`;
    }
    if (typeof gif.url !== 'string') return `results[${i}] missing "media_formats.${full}.url"`;
    if (!Array.isArray(gif.dims) || gif.dims.length < 2) {
      return `results[${i}] missing "media_formats.${full}.dims"`;
    }
    const tinygif = formats[preview] as Record<string, unknown> | undefined;
    if (tinygif == null || typeof tinygif !== 'object') {
      return `results[${i}] missing "media_formats.${preview}"`;
    }
    if (typeof tinygif.url !== 'string') {
      return `results[${i}] missing "media_formats.${preview}.url"`;
    }
    if (!Array.isArray(tinygif.dims) || tinygif.dims.length < 2) {
      return `results[${i}] missing "media_formats.${preview}.dims"`;
    }
  }
  return null;
}

function mapGif(gif: TenorCompatibleGif, kind: MediaKind): GifResult {
  const { full, preview } = FORMAT_KEYS[kind];
  const fullFormat = gif.media_formats[full]!;
  const previewFormat = gif.media_formats[preview]!;
  return {
    id: gif.id,
    kind,
    url: fullFormat.url,
    preview: previewFormat.url,
    width: fullFormat.dims[0],
    height: fullFormat.dims[1],
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
    // The media filter is chosen by KIND, not by static config. The
    // configured `mediaFilter` remains the default for plain GIFs so an
    // existing provider config keeps its exact behaviour.
    const kind = opts?.kind ?? 'gif';
    const filter = kind === 'gif' ? (mediaFilter ?? MEDIA_FILTERS.gif) : MEDIA_FILTERS[kind];
    if (filter) params.set('media_filter', filter);
    // Tenor's own parameter name, which KLIPY's v2 honours — confirmed
    // against the live API: the same query returns a different, sticker-only
    // result set with this set.
    if (kind === 'sticker') params.set('searchfilter', 'sticker');
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
    kind: MediaKind,
  ): Promise<TenorCompatibleResponse> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`[slingshot-gifs] ${providerLabel} ${label} returned malformed JSON`);
    }
    const validationError = validateResponse(body, kind);
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
      const kind = opts?.kind ?? 'gif';
      const body = await parseAndValidate(response, 'trending', kind);
      return body.results.map(g => mapGif(g, kind));
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
      const kind = opts?.kind ?? 'gif';
      const body = await parseAndValidate(response, 'search', kind);
      return body.results.map(g => mapGif(g, kind));
    },
  };
}

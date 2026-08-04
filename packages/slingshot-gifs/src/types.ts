import { z } from 'zod';

/**
 * A single GIF result returned by a provider.
 *
 * Fields are normalized across providers so consumers never need to know
 * which backend (Giphy, KLIPY, or Tenor) produced the result.
 */
export interface GifResult {
  /** Provider-specific unique identifier for the GIF. */
  id: string;
  /**
   * Whether this is a regular GIF or a transparent sticker.
   *
   * Carried on the RESULT, not just the request, because it changes how a
   * client must paint it: a sticker has an alpha channel and is meant to sit
   * directly on the page, so drawing it in the bordered, background-filled
   * tile a GIF wants produces a visible box around the artwork. A caller
   * merging both kinds into one list would otherwise have no way to tell.
   */
  kind: MediaKind;
  /** Full-resolution GIF URL. */
  url: string;
  /** Smaller preview GIF URL suitable for thumbnails or grid views. */
  preview: string;
  /** Original GIF width in pixels. */
  width: number;
  /** Original GIF height in pixels. */
  height: number;
  /** Human-readable title or description of the GIF. */
  title: string;
}

/**
 * Options for GIF search and trending queries.
 *
 * All fields are optional — providers apply their own defaults when omitted.
 */
export type MediaKind = 'gif' | 'sticker';

export interface GifSearchOptions {
  /**
   * Which media kind to fetch. Defaults to `'gif'`.
   *
   * Not every provider serves stickers; a provider that cannot MUST reject
   * the request rather than quietly return GIFs. Silently substituting a
   * different kind of media than the caller asked for is the failure mode
   * that reaches an end user as "the sticker tab is just GIFs again", with
   * nothing in any log to explain it.
   */
  kind?: MediaKind;
  /** Maximum number of results to return. */
  limit?: number;
  /** Zero-based offset for pagination. */
  offset?: number;
  /** Content rating filter (e.g. 'g', 'pg', 'pg-13', 'r'). Provider-specific values apply. */
  rating?: string;
}

/**
 * The provider contract for GIF search backends.
 *
 * Each provider implementation (Giphy, KLIPY, or Tenor) satisfies this interface.
 * The plugin resolves a single provider at startup and delegates all
 * search/trending calls through it.
 */
export interface GifProvider {
  /** Provider name for diagnostics (e.g. 'giphy', 'klipy', 'tenor'). */
  readonly name: string;
  /**
   * Fetch trending GIFs from the provider.
   *
   * @param opts - Optional search parameters (limit, offset, rating).
   * @returns An array of normalized GIF results.
   */
  trending(opts?: GifSearchOptions): Promise<GifResult[]>;
  /**
   * Search for GIFs matching a query string.
   *
   * @param query - The search term.
   * @param opts - Optional search parameters (limit, offset, rating).
   * @returns An array of normalized GIF results.
   */
  search(query: string, opts?: GifSearchOptions): Promise<GifResult[]>;
}

/**
 * Configuration for the slingshot-gifs plugin.
 *
 * Validated at plugin creation time via the companion Zod schema.
 */
export interface GifsPluginConfig {
  /** Which GIF provider backend to use. */
  provider: 'giphy' | 'klipy' | 'tenor';
  /** Server-side API key for the selected provider. Never exposed in responses. */
  apiKey: string;
  /** Content rating filter applied to all queries. Provider-specific values apply. */
  rating?: string;
  /** Default result limit per query. Defaults to 25. */
  limit?: number;
  /** Route mount path for the GIF endpoints. Defaults to '/gifs'. */
  mountPath?: string;
  /** Timeout in milliseconds for upstream provider fetch calls. Defaults to 10000 (10s). */
  fetchTimeoutMs?: number;
}

/**
 * Zod schema for {@link GifsPluginConfig}.
 *
 * Used by `validatePluginConfig` at plugin creation time to parse and
 * validate raw user-supplied config.
 */
export const gifsPluginConfigSchema = z.object({
  provider: z.enum(['giphy', 'klipy', 'tenor']),
  apiKey: z.string().min(1, 'apiKey must not be empty'),
  rating: z.string().optional(),
  limit: z.number().int().positive().optional().default(25),
  mountPath: z.string().startsWith('/').optional().default('/gifs'),
  fetchTimeoutMs: z.number().int().positive().optional().default(10_000),
});

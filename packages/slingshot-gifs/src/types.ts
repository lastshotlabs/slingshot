import { z } from 'zod';

/**
 * A single GIF result returned by a provider.
 *
 * Fields are normalized across providers so consumers never need to know
 * which backend (Giphy, Tenor) produced the result.
 */
export interface GifResult {
  /** Provider-specific unique identifier for the GIF. */
  id: string;
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
export interface GifSearchOptions {
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
 * Each provider implementation (Giphy, Tenor) satisfies this interface.
 * The plugin resolves a single provider at startup and delegates all
 * search/trending calls through it.
 */
export interface GifProvider {
  /** Provider name for diagnostics (e.g. 'giphy', 'tenor'). */
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
  provider: 'giphy' | 'tenor';
  /** Server-side API key for the selected provider. Never exposed in responses. */
  apiKey: string;
  /** Content rating filter applied to all queries. Provider-specific values apply. */
  rating?: string;
  /** Default result limit per query. Defaults to 25. */
  limit?: number;
  /** Route mount path for the GIF endpoints. Defaults to '/gifs'. */
  mountPath?: string;
}

/**
 * Zod schema for {@link GifsPluginConfig}.
 *
 * Used by `validatePluginConfig` at plugin creation time to parse and
 * validate raw user-supplied config.
 */
export const gifsPluginConfigSchema = z.object({
  provider: z.enum(['giphy', 'tenor']),
  apiKey: z.string().min(1, 'apiKey must not be empty'),
  rating: z.string().optional(),
  limit: z.number().int().positive().optional().default(25),
  mountPath: z.string().startsWith('/').optional().default('/gifs'),
});

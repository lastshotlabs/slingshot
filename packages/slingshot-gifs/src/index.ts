/**
 * @module @lastshotlabs/slingshot-gifs
 *
 * Stateless GIF search proxy plugin for slingshot.
 *
 * Provides swappable provider backends (Giphy, Tenor) with server-side API key
 * management. API keys are never exposed in HTTP responses — all provider calls
 * happen server-side and only normalized GIF result arrays are returned.
 *
 * @example
 * ```ts
 * import { createGifsPlugin } from '@lastshotlabs/slingshot-gifs';
 *
 * const gifsPlugin = createGifsPlugin({
 *   provider: 'giphy',
 *   apiKey: process.env.GIPHY_API_KEY!,
 * });
 * ```
 */

export { createGifsPlugin } from './plugin';
export type { GifProvider, GifResult, GifSearchOptions, GifsPluginConfig } from './types';
export { gifsPluginConfigSchema } from './types';
export { createGiphyProvider } from './providers/giphy';
export { createTenorProvider } from './providers/tenor';

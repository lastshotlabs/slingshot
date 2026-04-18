import type { GifProvider, GifsPluginConfig } from '../types';
import { createGiphyProvider } from './giphy';
import { createTenorProvider } from './tenor';

/**
 * Resolve the concrete {@link GifProvider} for the given plugin config.
 *
 * Dispatches on `config.provider` and constructs the matching provider factory
 * with the shared config fields (apiKey, rating, limit).
 *
 * @param config - Validated plugin configuration.
 * @returns A fully constructed `GifProvider` ready for use.
 * @throws {Error} If `config.provider` is not a recognised provider name.
 */
export function resolveGifProvider(config: GifsPluginConfig): GifProvider {
  const { apiKey, rating, limit } = config;

  switch (config.provider) {
    case 'giphy':
      return createGiphyProvider({ apiKey, rating, limit });
    case 'tenor':
      return createTenorProvider({ apiKey, rating, limit });
    default:
      throw new Error(
        `[slingshot-gifs] Unknown GIF provider "${config.provider as string}". ` +
          `Supported providers: giphy, tenor.`,
      );
  }
}

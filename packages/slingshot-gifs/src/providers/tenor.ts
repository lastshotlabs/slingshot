import type { GifProvider } from '../types';
import { createTenorCompatibleProvider } from './tenorCompatible';

/**
 * Create a Tenor-backed {@link GifProvider}.
 *
 * Tenor v2 uses `key` for the API key and `client_key` for app identification.
 * The API key remains closure-owned and all HTTP calls use the runtime's global
 * `fetch()` implementation.
 */
export function createTenorProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
  fetchTimeoutMs?: number;
}): GifProvider {
  return createTenorCompatibleProvider({
    ...config,
    providerName: 'tenor',
    providerLabel: 'Tenor',
    baseUrl: 'https://tenor.googleapis.com/v2',
  });
}

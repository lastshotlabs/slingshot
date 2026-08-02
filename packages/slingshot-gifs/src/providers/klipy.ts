import type { GifProvider } from '../types';
import { createTenorCompatibleProvider } from './tenorCompatible';

/**
 * Create a KLIPY-backed {@link GifProvider}.
 *
 * KLIPY exposes an officially supported Tenor-v2-compatible API at
 * `api.klipy.com`. Only the normalized full-size and preview GIF formats are
 * requested. The API key remains closure-owned and never reaches clients.
 */
export function createKlipyProvider(config: {
  apiKey: string;
  rating?: string;
  limit?: number;
  fetchTimeoutMs?: number;
}): GifProvider {
  return createTenorCompatibleProvider({
    ...config,
    providerName: 'klipy',
    providerLabel: 'KLIPY',
    baseUrl: 'https://api.klipy.com/v2',
    mediaFilter: 'gif,tinygif',
  });
}

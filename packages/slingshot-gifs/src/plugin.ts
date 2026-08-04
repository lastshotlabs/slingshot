import { Hono } from 'hono';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { validatePluginConfig } from '@lastshotlabs/slingshot-core';
import { resolveGifProvider } from './providers/index';
import { gifsPluginConfigSchema } from './types';
import type { MediaKind } from './types';

function parseOffset(rawOffset: string | undefined): number | undefined | null {
  if (rawOffset === undefined) return undefined;
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) return null;
  return offset;
}

/**
 * Create the slingshot-gifs plugin for proxied GIF search.
 *
 * Validates config with Zod, freezes it at the boundary, and resolves the
 * appropriate provider (Giphy, KLIPY, or Tenor) in the closure. Routes are mounted
 * during `setupRoutes`.
 *
 * The server-side API key is never exposed in HTTP responses — all provider
 * calls happen server-side and only normalized {@link GifResult} arrays are
 * returned to clients.
 *
 * @param rawConfig - Raw plugin configuration. Validated against {@link gifsPluginConfigSchema}.
 * @returns A `SlingshotPlugin` instance ready to be passed to `createServer`.
 * @throws {Error} If `rawConfig` fails Zod schema validation.
 *
 * @example
 * ```ts
 * import { createGifsPlugin } from '@lastshotlabs/slingshot-gifs';
 *
 * const gifsPlugin = createGifsPlugin({
 *   provider: 'giphy',
 *   apiKey: process.env.GIPHY_API_KEY!,
 *   rating: 'pg',
 * });
 * ```
 */
/**
 * Parse the `kind` query parameter into a {@link MediaKind}.
 *
 * Returns `null` for anything unrecognised so the route can answer 400. An
 * unknown kind MUST NOT fall back to `'gif'`: a typo'd `?kind=stickers` that
 * quietly returns GIFs reaches the user as "the sticker tab is just GIFs",
 * with a 200 in the logs and nothing to explain it. The same reasoning the
 * rating filter follows — a value we do not understand is an error, not a
 * default.
 */
function parseKind(raw: string | undefined): MediaKind | null {
  if (raw === undefined || raw === '') return 'gif';
  return raw === 'gif' || raw === 'sticker' ? raw : null;
}

export function createGifsPlugin(rawConfig: unknown): SlingshotPlugin {
  const config = Object.freeze(
    validatePluginConfig('slingshot-gifs', rawConfig, gifsPluginConfigSchema),
  );

  const provider = resolveGifProvider(config);
  const mountPath = config.mountPath;

  return {
    name: 'slingshot-gifs',

    setupRoutes({ app }: PluginSetupContext): void {
      const router = new Hono();

      router.get('/trending', async c => {
        const offset = parseOffset(c.req.query('offset'));
        if (offset === null) {
          return c.json({ error: 'Query parameter "offset" must be a non-negative integer.' }, 400);
        }
        const kind = parseKind(c.req.query('kind'));
        if (kind === null) {
          return c.json({ error: 'Query parameter "kind" must be "gif" or "sticker".' }, 400);
        }
        const results = await provider.trending({
          limit: config.limit,
          rating: config.rating,
          offset,
          kind,
        });
        return c.json({ results });
      });

      router.get('/search', async c => {
        const q = c.req.query('q');
        if (!q || q.trim().length === 0) {
          return c.json({ error: 'Query parameter "q" is required.' }, 400);
        }
        const offset = parseOffset(c.req.query('offset'));
        if (offset === null) {
          return c.json({ error: 'Query parameter "offset" must be a non-negative integer.' }, 400);
        }
        const kind = parseKind(c.req.query('kind'));
        if (kind === null) {
          return c.json({ error: 'Query parameter "kind" must be "gif" or "sticker".' }, 400);
        }
        const results = await provider.search(q, {
          limit: config.limit,
          rating: config.rating,
          offset,
          kind,
        });
        return c.json({ results });
      });

      app.route(mountPath, router);
    },
  };
}

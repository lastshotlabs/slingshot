import { Hono } from 'hono';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  EMBEDS_PLUGIN_STATE_KEY,
  getPluginStateOrNull,
  publishPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEmbedCache } from './lib/cache';
import { validateUrl } from './lib/ssrfGuard';
import { unfurl } from './lib/unfurl';
import { type EmbedsPluginConfig, embedsPluginConfigSchema } from './types';

/**
 * Create the slingshot-embeds plugin for URL unfurling.
 *
 * Returns a stateless plugin that exposes a `POST /embeds/unfurl` endpoint
 * (mount path is configurable). The endpoint accepts `{ url: string }`,
 * validates the URL against SSRF rules and domain lists, fetches the page
 * server-side, parses OG/meta tags, and returns structured metadata.
 *
 * Results are cached in-memory with a configurable TTL.
 *
 * @param rawConfig - Raw plugin configuration (validated via Zod).
 * @returns A {@link SlingshotPlugin} instance.
 *
 * @example
 * ```ts
 * import { createEmbedsPlugin } from '@lastshotlabs/slingshot-embeds';
 *
 * const embeds = createEmbedsPlugin({ cacheTtlMs: 60_000 });
 * ```
 */
export function createEmbedsPlugin(rawConfig?: unknown): SlingshotPlugin {
  const config: EmbedsPluginConfig = validatePluginConfig(
    'slingshot-embeds',
    rawConfig ?? {},
    embedsPluginConfigSchema,
  );
  const frozenConfig = Object.freeze(config);

  const cache = createEmbedCache({
    ttlMs: frozenConfig.cacheTtlMs,
    maxEntries: frozenConfig.cacheMaxEntries,
  });

  async function unfurlUrls(urls: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const targetUrl of urls) {
      const validation = validateUrl(targetUrl, {
        allowedDomains: frozenConfig.allowedDomains,
        blockedDomains: frozenConfig.blockedDomains,
      });
      if (!validation.valid) {
        continue;
      }

      const cached = cache.get(targetUrl);
      if (cached) {
        results.push(cached);
        continue;
      }

      try {
        const result = await unfurl(targetUrl, {
          timeoutMs: frozenConfig.timeoutMs,
          maxResponseBytes: frozenConfig.maxResponseBytes,
          maxRedirects: frozenConfig.maxRedirects,
        });
        cache.set(targetUrl, result);
        results.push(result);
      } catch {
        // Optional peer integration must fail closed per URL.
      }
    }
    return results;
  }

  return {
    name: EMBEDS_PLUGIN_STATE_KEY,

    setupRoutes({ app }: PluginSetupContext) {
      const router = new Hono();
      const pluginState = getPluginStateOrNull(app);
      if (pluginState) {
        publishPluginState(
          pluginState,
          EMBEDS_PLUGIN_STATE_KEY,
          Object.freeze({
            unfurl: unfurlUrls,
          }),
        );
      }

      router.post('/unfurl', async c => {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: 'Invalid JSON body' }, 400);
        }

        if (
          !body ||
          typeof body !== 'object' ||
          !('url' in body) ||
          typeof (body as Record<string, unknown>).url !== 'string'
        ) {
          return c.json({ error: 'Missing required field: url (string)' }, 400);
        }

        const targetUrl = (body as Record<string, unknown>).url as string;

        // SSRF validation
        const validation = validateUrl(targetUrl, {
          allowedDomains: frozenConfig.allowedDomains,
          blockedDomains: frozenConfig.blockedDomains,
        });

        if (!validation.valid) {
          return c.json({ error: `URL rejected: ${validation.reason}` }, 400);
        }

        // Check cache
        const cached = cache.get(targetUrl);
        if (cached) {
          return c.json(cached);
        }

        // Unfurl
        try {
          const [result] = await unfurlUrls([targetUrl]);
          if (!result) {
            return c.json({ error: 'Failed to unfurl URL: Unknown error' }, 502);
          }
          return c.json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return c.json({ error: `Failed to unfurl URL: ${message}` }, 502);
        }
      });

      app.route(frozenConfig.mountPath, router);
    },

    teardown() {
      cache.clear();
    },
  };
}

import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type { DeepLinksConfig } from './config';
import { expandFallback } from './fallback';

/** Canonical Apple AASA route path. */
export const APPLE_AASA_PATH = '/.well-known/apple-app-site-association';
/** Canonical Android asset links route path. */
export const ANDROID_ASSETLINKS_PATH = '/.well-known/assetlinks.json';

/** Public well-known routes served by the deep-links plugin. */
export const DEEP_LINKS_PUBLIC_PATHS: readonly string[] = [
  APPLE_AASA_PATH,
  ANDROID_ASSETLINKS_PATH,
];

/**
 * Mount the Apple App Site Association route when Apple config is present.
 *
 * @param app - Hono application instance to mount the route on.
 * @param body - Pre-serialized AASA JSON string, or `null` to skip mounting.
 */
export function mountAppleAasaRoute(app: Hono<AppEnv>, body: string | null): void {
  if (body === null) return;

  app.get(APPLE_AASA_PATH, c =>
    c.body(body, 200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    }),
  );
}

/**
 * Mount the Android Digital Asset Links route when Android config is present.
 *
 * @param app - Hono application instance to mount the route on.
 * @param body - Pre-serialized assetlinks JSON string, or `null` to skip mounting.
 */
export function mountAndroidAssetlinksRoute(app: Hono<AppEnv>, body: string | null): void {
  if (body === null) return;

  app.get(ANDROID_ASSETLINKS_PATH, c =>
    c.body(body, 200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    }),
  );
}

/**
 * Mount configured fallback redirect routes for paths declared in the AASA config.
 *
 * Each source pattern (e.g. `/share/*`) is registered as a Hono GET route that
 * redirects to `fallbackBaseUrl + expandFallback(source, target, path)`. A 404
 * is returned when `expandFallback` cannot match the request path.
 *
 * @param app - Hono application instance to mount routes on.
 * @param config - Compiled deep-links config with optional fallback redirect map.
 */
export function mountFallbackRoutes(app: Hono<AppEnv>, config: DeepLinksConfig): void {
  if (!config.fallbackRedirects || !config.fallbackBaseUrl) return;

  for (const [source, target] of Object.entries(config.fallbackRedirects)) {
    const honoPath = source.slice(0, -1) + '*';
    app.get(honoPath, c => {
      const expanded = expandFallback(source, target, c.req.path);
      if (!expanded) return c.notFound();
      return c.redirect(`${config.fallbackBaseUrl}${expanded}`, 302);
    });
  }
}

/**
 * Mount every route owned by the deep-links plugin.
 *
 * Calls `mountAppleAasaRoute`, `mountAndroidAssetlinksRoute`, and
 * `mountFallbackRoutes` in order. Routes are only registered when the
 * corresponding config section is present (non-null body / non-empty map).
 *
 * @param app - Hono application instance to mount routes on.
 * @param aasaBody - Pre-serialized AASA JSON string, or `null`.
 * @param assetlinksBody - Pre-serialized assetlinks JSON string, or `null`.
 * @param config - Compiled deep-links config.
 */
export function mountDeepLinkRoutes(
  app: Hono<AppEnv>,
  aasaBody: string | null,
  assetlinksBody: string | null,
  config: DeepLinksConfig,
): void {
  mountAppleAasaRoute(app, aasaBody);
  mountAndroidAssetlinksRoute(app, assetlinksBody);
  mountFallbackRoutes(app, config);
}

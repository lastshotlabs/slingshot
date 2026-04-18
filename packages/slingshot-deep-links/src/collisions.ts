import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type { DeepLinksConfig } from './config';
import { ANDROID_ASSETLINKS_PATH, APPLE_AASA_PATH } from './routes';

function pathCollides(aasaPattern: string, honoPath: string): boolean {
  const aasaPrefix = aasaPattern.endsWith('/*') ? aasaPattern.slice(0, -1) : aasaPattern;
  const honoPrefix = honoPath.replace(/:([A-Za-z]\w*)/g, '');

  return (
    honoPrefix === aasaPrefix ||
    honoPrefix.startsWith(aasaPrefix) ||
    aasaPrefix.startsWith(honoPrefix + '/') ||
    aasaPrefix === honoPrefix + '/'
  );
}

type HonoRoute = {
  method: string;
  path: string;
};

type CollisionLogger = Pick<Console, 'warn'> | null | undefined;

/**
 * Warn when a registered Hono route overlaps with an Apple AASA declared path.
 *
 * Apple's verifier crawls AASA-declared paths. If the same path is also handled
 * by an app route that requires auth or returns something other than a deep-link
 * redirect, iOS will silently refuse to open those URLs as universal links.
 *
 * This function compares every route registered on `app` (via `app.routes`) with
 * every `paths` entry from the Apple config and emits a structured warning for
 * each overlap found. It skips the plugin's own well-known paths and its own
 * fallback redirect routes.
 *
 * @param app - Hono application instance with routes already registered.
 * @param config - Compiled deep-links config.
 * @param logger - Logger with a `warn` method, or `null`/`undefined` to suppress.
 */
export function warnOnPathCollisions(
  app: Hono<AppEnv>,
  config: DeepLinksConfig,
  logger: CollisionLogger,
): void {
  if (!config.apple || config.apple.length === 0) return;

  const ownPaths = new Set<string>([APPLE_AASA_PATH, ANDROID_ASSETLINKS_PATH]);
  if (config.fallbackRedirects) {
    for (const source of Object.keys(config.fallbackRedirects)) {
      ownPaths.add(source.slice(0, -1) + '*');
    }
  }

  const routes =
    'routes' in (app as object) ? ((app as { routes?: HonoRoute[] }).routes ?? []) : [];
  const aasaPaths = new Set(config.apple.flatMap(entry => entry.paths));

  for (const route of routes) {
    if (ownPaths.has(route.path)) continue;

    for (const pattern of aasaPaths) {
      if (!pathCollides(pattern, route.path)) continue;

      logger?.warn(
        {
          plugin: 'slingshot-deep-links',
          aasaPath: pattern,
          routeMethod: route.method,
          routePath: route.path,
        },
        `deep-links AASA path '${pattern}' overlaps with a registered ${route.method} ${route.path} route`,
      );
    }
  }
}

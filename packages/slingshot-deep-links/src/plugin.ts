import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getPluginState, publishPluginState } from '@lastshotlabs/slingshot-core';
import { serializeAppleAasaBody } from './aasa';
import { serializeAssetlinksBody } from './assetlinks';
import { warnOnPathCollisions } from './collisions';
import { type DeepLinksConfigInput, compileDeepLinksConfig } from './config';
import { DEEP_LINKS_PUBLIC_PATHS, mountDeepLinkRoutes } from './routes';
import type { DeepLinksPluginState } from './state';
import { DEEP_LINKS_PLUGIN_STATE_KEY } from './stateKey';

/**
 * Create the deep-links plugin.
 *
 * Validates and compiles `input` via `compileDeepLinksConfig`, pre-serializes
 * the AASA and assetlinks JSON bodies once at plugin construction time, and
 * mounts the well-known routes during `setupRoutes`. Path collision warnings
 * are emitted in `setupPost` after all other plugins have registered their routes.
 *
 * The plugin declares both well-known paths in `publicPaths` so auth middleware
 * skips them automatically — no manual exclusion is needed.
 *
 * @param input - Raw deep-links config (JSON-safe, accepted from manifest bootstrap).
 * @returns A Slingshot plugin that serves `/.well-known/apple-app-site-association`
 *   and/or `/.well-known/assetlinks.json`.
 *
 * @example
 * ```ts
 * import { createDeepLinksPlugin } from '@lastshotlabs/slingshot-deep-links';
 *
 * const plugin = createDeepLinksPlugin({
 *   apple: { teamId: 'TEAM123456', bundleId: 'com.example.app', paths: ['/share/*'] },
 *   android: {
 *     packageName: 'com.example.app',
 *     sha256Fingerprints: ['AA:BB:...:99'],
 *   },
 *   fallbackBaseUrl: 'https://example.com',
 *   fallbackRedirects: { '/share/*': '/posts/:id' },
 * });
 * ```
 */
export function createDeepLinksPlugin(input: DeepLinksConfigInput): SlingshotPlugin {
  const config = compileDeepLinksConfig(input);
  const aasaBody = serializeAppleAasaBody(config.apple);
  const assetlinksBody = serializeAssetlinksBody(config.android);

  const state: DeepLinksPluginState = Object.freeze({
    config,
    aasaBody,
    assetlinksBody,
  });

  return {
    name: DEEP_LINKS_PLUGIN_STATE_KEY,
    dependencies: [],
    publicPaths: [...DEEP_LINKS_PUBLIC_PATHS],

    setupMiddleware({ app }: PluginSetupContext) {
      publishPluginState(getPluginState(app), DEEP_LINKS_PLUGIN_STATE_KEY, state);
    },

    setupRoutes({ app }: PluginSetupContext) {
      mountDeepLinkRoutes(app, aasaBody, assetlinksBody, config);
    },

    setupPost({ app }: PluginSetupContext) {
      warnOnPathCollisions(app, config, console);
    },
  };
}

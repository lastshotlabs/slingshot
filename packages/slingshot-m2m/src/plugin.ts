import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getContextOrNull } from '@lastshotlabs/slingshot-core';
import { createM2MRouter } from './routes/m2m';

/**
 * Creates the Slingshot M2M (machine-to-machine) plugin.
 *
 * Mounts an OAuth 2.0 `POST /oauth/token` endpoint that issues short-lived
 * JWTs via the `client_credentials` grant. Requires `slingshot-auth` to be
 * registered as a dependency and `auth.m2m` to be set in the auth plugin
 * config.
 *
 * @returns A `SlingshotPlugin` to pass to `createApp()` / `createServer()`.
 *
 * @throws {Error} During `setupRoutes` if `slingshot-auth` is not configured
 *   with an `m2m` block (`auth.m2m` missing in the auth plugin config).
 *
 * @remarks
 * Use `requireScope()` middleware to protect routes that should only be
 * accessible with specific OAuth scopes granted to M2M clients.
 *
 * @example
 * ```ts
 * import { createM2MPlugin } from '@lastshotlabs/slingshot-m2m';
 *
 * const app = await createApp({
 *   plugins: [authPlugin, createM2MPlugin()],
 * });
 * ```
 */
export function createM2MPlugin(): SlingshotPlugin {
  return {
    name: 'slingshot-m2m',
    dependencies: ['slingshot-auth'],

    setupRoutes({ app }: PluginSetupContext) {
      const runtime = getAuthRuntimeContext(getContextOrNull(app));
      if (!runtime.config.m2m) {
        throw new Error(
          '[slingshot-m2m] M2M is not configured in slingshot-auth. Set auth.m2m in the auth plugin config.',
        );
      }
      app.route('/', createM2MRouter(runtime));
    },
  };
}

import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';
import { isJwksLoaded } from './lib/jwks';
import { createOidcRouter } from './routes/oidc';

/**
 * Creates the Slingshot OIDC discovery and JWKS plugin.
 *
 * Mounts two well-known endpoints on the application:
 * - `GET /.well-known/openid-configuration` — OIDC discovery document
 * - `GET /.well-known/jwks.json`            — JSON Web Key Set (public keys)
 *
 * Requires `slingshot-auth` to be registered as a dependency and
 * `auth.oidc` to be set in the auth plugin config with a loaded signing key.
 *
 * @returns A `SlingshotPlugin` to pass to `createApp()` / `createServer()`.
 *
 * @throws {Error} During `setupRoutes` if `slingshot-auth` is not configured
 *   with an `oidc` block or if no OIDC signing key has been loaded.
 *
 * @remarks
 * Use `loadJwksKey` / `generateAndLoadKeyPair` from the `jwks` module to
 * attach RS256 signing keys to the OIDC config before starting the server.
 * The plugin now fails closed when OIDC is enabled without a signing key,
 * rather than publishing discovery metadata with an empty JWKS.
 *
 * @example
 * ```ts
 * import { createOidcPlugin } from '@lastshotlabs/slingshot-oidc';
 *
 * const app = await createApp({
 *   plugins: [authPlugin, createOidcPlugin()],
 * });
 * ```
 */
export function createOidcPlugin(): SlingshotPlugin {
  return {
    name: 'slingshot-oidc',
    dependencies: ['slingshot-auth'],

    setupRoutes({ app }: PluginSetupContext) {
      const runtime = getAuthRuntimeContext(getPluginStateOrNull(app));
      if (!runtime.config.oidc) {
        throw new Error(
          '[slingshot-oidc] OIDC is not configured in slingshot-auth. Set auth.oidc in the auth plugin config.',
        );
      }
      if (!isJwksLoaded(runtime.config)) {
        throw new Error(
          '[slingshot-oidc] OIDC requires a signing key before routes can be mounted. Load one with loadJwksKey() or generateAndLoadKeyPair().',
        );
      }
      app.route('/', createOidcRouter(runtime.config));
    },
  };
}

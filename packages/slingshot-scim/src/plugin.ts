import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';
import { createScimRouter } from './routes/scim';

/**
 * Creates the slingshot-scim plugin, which adds SCIM 2.0 user provisioning to a Slingshot app.
 *
 * Requires `slingshot-auth` to be installed and configured with `auth.scim` settings in the
 * auth plugin config. Routes are mounted at `/scim/v2/*` during `setupRoutes`.
 *
 * Supported SCIM 2.0 endpoints:
 * - `GET /scim/v2/Users` — list/search users with single-clause filter support
 * - `GET /scim/v2/Users/:id` — retrieve a single user
 * - `POST /scim/v2/Users` — provision a new user
 * - `PUT /scim/v2/Users/:id` — full user replacement
 * - `PATCH /scim/v2/Users/:id` — partial update (PatchOp)
 * - `DELETE /scim/v2/Users/:id` — deprovision (suspend or hard-delete, configurable)
 * - `GET /scim/v2/ServiceProviderConfig` — capability discovery
 * - `GET /scim/v2/ResourceTypes` — resource type discovery
 *
 * @returns A `SlingshotPlugin` instance ready to be passed to `createServer`.
 * @throws {Error} During `setupRoutes` if `auth.scim` is not configured in the auth plugin.
 *
 * @example
 * ```ts
 * import { createScimPlugin } from '@lastshotlabs/slingshot-scim';
 *
 * const scimPlugin = createScimPlugin();
 * // Register in createServer({ plugins: [..., scimPlugin] })
 * ```
 */
export function createScimPlugin(): SlingshotPlugin {
  return {
    name: 'slingshot-scim',
    dependencies: ['slingshot-auth'],

    setupRoutes({ app }: PluginSetupContext) {
      const runtime = getAuthRuntimeContext(getPluginStateOrNull(app));
      if (!runtime.config.scim) {
        throw new Error(
          '[slingshot-scim] SCIM is not configured in slingshot-auth. Set auth.scim in the auth plugin config.',
        );
      }
      app.route('/', createScimRouter(runtime));
    },
  };
}

/**
 * Server-level permissions configuration.
 *
 * When set, the framework bootstraps a shared `PermissionsAdapter`,
 * `PermissionRegistry`, and `PermissionEvaluator` from the existing infra
 * connection and writes them to `ctx.pluginState` at `PERMISSIONS_STATE_KEY`
 * before any plugin setup phase runs.
 *
 * Plugins that accept `permissions` in their own config remain backward
 * compatible - an explicit plugin-level config takes precedence over the
 * server-level bootstrap.
 *
 * Requires `@lastshotlabs/slingshot-permissions` to be installed. A clear
 * error is thrown at startup if the package is missing.
 *
 * @example
 * ```ts
 * createServer({
 *   db: { sqlite: './data.db', auth: 'sqlite' },
 *   permissions: { adapter: 'sqlite' },
 * });
 * ```
 */
export interface PermissionsConfig {
  /**
   * Which store backend to use for the permissions adapter.
   * Must match a store already configured in `db`.
   */
  adapter: 'sqlite' | 'postgres' | 'mongo' | 'memory';
}

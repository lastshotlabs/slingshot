import type { Hono } from 'hono';
import type { AppEnv } from './context';
import type { SlingshotFrameworkConfig } from './context/frameworkConfig';
import type { SlingshotEventBus } from './eventBus';

/**
 * Context object passed to all plugin lifecycle methods.
 *
 * Using an options object instead of positional parameters means adding a new
 * field in the future is non-breaking — plugins that don't need the new field
 * simply don't destructure it.
 *
 * @example
 * ```ts
 * async setupRoutes({ app, bus }: PluginSetupContext) {
 *   app.route('/my-plugin', myRouter);
 *   bus.registerClientSafeEvents(['my-plugin:event.created']);
 * }
 * ```
 */
export interface PluginSetupContext {
  /** The `Hono` app instance to register middleware or routes on. */
  app: Hono<AppEnv>;
  /** Resolved framework configuration for this app instance. */
  config: SlingshotFrameworkConfig;
  /** The instance-owned event bus. */
  bus: SlingshotEventBus;
}

/**
 * The core plugin contract for Slingshot framework plugins.
 *
 * Plugins extend the framework by implementing one or more lifecycle phase methods.
 * The framework calls each phase in a fixed order during server bootstrap, giving
 * plugins deterministic control over when their middleware and routes are registered.
 *
 * @remarks
 * Declare `dependencies` to ensure prerequisite plugins are registered first.
 * The framework resolves dependency order before calling any plugin phases.
 * Plugin runtime state should be stored in `ctx.pluginState.get(plugin.name)` during
 * `setupPost` so that state is instance-scoped rather than module-global.
 *
 * @example
 * ```ts
 * import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
 *
 * export const myPlugin: SlingshotPlugin = {
 *   name: 'my-plugin',
 *   async setupMiddleware({ app }) {
 *     app.use(myAuthMiddleware());
 *   },
 *   async setupRoutes({ app }) {
 *     app.route('/my-plugin', myRouter);
 *   },
 * };
 * ```
 */
export interface SlingshotPlugin {
  /**
   * Unique plugin identifier.
   *
   * Used as the lookup key in `ctx.pluginState` (i.e. `ctx.pluginState.get(plugin.name)`)
   * and in the plugin registry that `createApp()` builds. Must be unique across all plugins
   * registered with a single app instance — duplicate names will cause a bootstrap error.
   *
   * @example `'slingshot-auth'`, `'my-company:search'`
   */
  name: string;
  /**
   * Names of other plugins that must be fully registered before this plugin's lifecycle
   * methods run.
   *
   * Each string must match the `name` field of another registered plugin. The framework
   * performs a topological sort of all registered plugins at bootstrap time using this
   * array. A cycle (plugin A depends on B, B depends on A) causes a startup error.
   *
   * @remarks
   * Declaring a dependency guarantees ordering, not availability. If a dependency plugin
   * is not registered with the same app instance, bootstrap will throw. For truly optional
   * cross-plugin coordination, read `ctx.pluginState.get('other-plugin')` inside
   * `setupPost` and handle `null` yourself.
   *
   * @example `['slingshot-auth', 'slingshot-tenancy']`
   */
  dependencies?: string[];

  /**
   * URL path prefixes that should bypass tenant resolution when this plugin is registered.
   *
   * The framework folds these into `tenancy.exemptPaths` before mounting tenant middleware,
   * allowing plugins to declare routes that must be reachable before a tenant is known
   * (for example, tenant-selection or account-discovery endpoints).
   */
  tenantExemptPaths?: string[];

  /**
   * URL path prefixes that should bypass CSRF validation when this plugin is registered.
   *
   * The framework folds these into `security.csrf.exemptPaths` before auth middleware
   * mounts, allowing plugins to expose endpoints that cannot carry CSRF headers.
   */
  csrfExemptPaths?: string[];

  /**
   * URL paths that must bypass framework-level public-path aware middleware.
   *
   * Declared public paths are collected during app bootstrap, exposed on
   * `ctx.publicPaths`, and consumed by helpers like `isPublicPath()` so middleware can
   * skip auth, CSRF, rate limiting, and other checks for machine-consumed endpoints.
   *
   * Matching supports exact equality and a trailing `*` wildcard for prefix checks.
   *
   * @remarks
   * Use this only for endpoints that must be reachable without credentials or browser
   * state, such as OS-level verifiers under `/.well-known/`.
   *
   * @example
   * ```ts
   * publicPaths: [
   *   '/.well-known/apple-app-site-association',
   *   '/.well-known/assetlinks.json',
   * ]
   * ```
   */
  publicPaths?: string[];

  /**
   * Called after framework middleware (requestId, metrics, logger, secureHeaders, cors, bot,
   * rateLimit) and before tenant/custom middleware. Use this for request middleware that must
   * run early in the chain (e.g. auth, CSRF, MFA enforcement).
   */
  setupMiddleware?(ctx: PluginSetupContext): void | Promise<void>;

  /**
   * Called after tenant and custom middleware, before framework route mounting and user route
   * discovery. Use this to mount plugin routes so they receive tenant context.
   *
   * Auth routes receive tenant context because tenant middleware runs before this phase.
   */
  setupRoutes?(ctx: PluginSetupContext): void | Promise<void>;

  /**
   * Called after all routes, OpenAPI docs, and error handlers are registered.
   * Use this for post-assembly inspection, metrics registration, or other post-startup work.
   *
   * NOT for registering routes or request middleware — routes registered here are invisible
   * to OpenAPI and unreachable by app.onError.
   */
  setupPost?(ctx: PluginSetupContext): void | Promise<void>;

  /**
   * Standalone convenience — the framework NEVER calls this method.
   *
   * Plain Hono apps (without the full Slingshot framework orchestrator) call `setup()` directly
   * to register middleware and routes in one call. A typical implementation calls
   * `setupMiddleware` then `setupRoutes` in sequence.
   *
   * Define `setupMiddleware`/`setupRoutes`/`setupPost` for framework integration.
   * Define `setup` for standalone usage. Both can coexist without double-execution risk —
   * the framework calls only the phase methods, never `setup()`.
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>;

  /**
   * Tear down plugin resources when the server shuts down.
   * Close connections, clear timers, flush buffers.
   */
  teardown?(): void | Promise<void>;
}

/**
 * A plugin that guarantees a `setup` implementation for standalone (non-framework) usage.
 *
 * Use this type when a plain Hono app calls `plugin.setup(app, config, bus)` directly
 * instead of going through the full framework orchestrator. Narrow `SlingshotPlugin` to
 * `StandalonePlugin` when you need a compile-time guarantee that `setup` is present.
 *
 * @remarks
 * The key guarantee: assigning a value to `StandalonePlugin` is a compile-time error if
 * `setup` is missing or optional. This prevents a runtime crash when calling
 * `plugin.setup(...)` in a plain Hono context where the framework lifecycle is absent.
 *
 * A `StandalonePlugin` can still implement `setupMiddleware`, `setupRoutes`, and
 * `setupPost` — those fields are inherited from `SlingshotPlugin`. If the plugin is later
 * registered with a full Slingshot app, the framework will call the phase methods and never
 * call `setup`. Both paths can coexist without double-execution risk.
 *
 * @example
 * ```ts
 * import type { StandalonePlugin } from '@lastshotlabs/slingshot-core';
 * import { Hono } from 'hono';
 *
 * // Compile error if setup() is absent — guarantees safe direct call below.
 * export const myPlugin: StandalonePlugin = {
 *   name: 'my-plugin',
 *   async setup(app, config, bus) {
 *     app.use(myMiddleware());
 *     app.route('/my-plugin', myRouter);
 *   },
 * };
 *
 * // Safe: TypeScript knows setup() is non-optional here.
 * const app = new Hono();
 * await myPlugin.setup({ app, config, bus });
 * ```
 */
export interface StandalonePlugin extends SlingshotPlugin {
  setup(ctx: PluginSetupContext): void | Promise<void>;
}

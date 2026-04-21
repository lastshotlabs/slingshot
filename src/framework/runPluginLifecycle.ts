/**
 * Plugin lifecycle execution — extracted from createApp().
 *
 * Handles plugin dependency validation, topological sorting,
 * and execution of the three framework lifecycle phases.
 */
import { withSpan } from '@framework/otel/spans';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Tracer } from '@opentelemetry/api';
import type {
  AppEnv,
  SlingshotEventBus,
  SlingshotEvents,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import type { FrameworkConfig } from './createInfrastructure';

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Sort plugins in topological dependency order using depth-first search.
 *
 * Each plugin is visited once; its declared `dependencies` are visited
 * recursively before the plugin itself is appended to the result.  This
 * guarantees that dependencies always appear before their dependents in the
 * returned array.
 *
 * Only plugins that participate in at least one framework lifecycle phase
 * (`setupMiddleware`, `setupRoutes`, `setupPost`) should be passed to this
 * function — see {@link validateAndSortPlugins} which filters them first.
 *
 * @param plugins - Array of `SlingshotPlugin` objects to sort.  Must include all
 *   plugins referenced as dependencies (missing dependencies throw).
 * @returns A new array of plugins in safe execution order (dependencies first).
 * @throws {Error} When a circular dependency is detected.  The error message
 *   includes the full cycle path (e.g. `"a -> b -> c -> a"`).
 * @throws {Error} When a declared dependency is not found in `plugins`.
 */
function topologicalSort(plugins: SlingshotPlugin[]): SlingshotPlugin[] {
  const nameToPlugin = new Map(plugins.map(p => [p.name, p]));
  const completed = new Set<string>();
  const inProgress = new Set<string>();
  const result: SlingshotPlugin[] = [];

  function visit(name: string, path: string[]) {
    if (completed.has(name)) return;
    if (inProgress.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new Error(`[slingshot] Circular plugin dependency detected: ${cycle.join(' → ')}`);
    }
    const plugin = nameToPlugin.get(name);
    if (!plugin) {
      throw new Error(
        `[slingshot] Plugin dependency "${name}" not found (required by "${path[path.length - 1] ?? 'root'}").`,
      );
    }
    inProgress.add(name);
    for (const dep of plugin.dependencies ?? []) {
      visit(dep, [...path, name]);
    }
    inProgress.delete(name);
    completed.add(name);
    result.push(plugin);
  }

  for (const plugin of plugins) {
    visit(plugin.name, []);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Plugin validation
// ---------------------------------------------------------------------------

function getEarliestPhase(p: SlingshotPlugin): number {
  if (p.setupMiddleware) return 0;
  if (p.setupRoutes) return 1;
  if (p.setupPost) return 2;
  return 3; // setup-only (standalone)
}

const PHASE_NAMES = ['setupMiddleware', 'setupRoutes', 'setupPost', 'setup-only (standalone)'];

function participatesInFrameworkLifecycle(plugin: SlingshotPlugin): boolean {
  return (
    typeof plugin.setupMiddleware === 'function' ||
    typeof plugin.setupRoutes === 'function' ||
    typeof plugin.setupPost === 'function'
  );
}

/**
 * Validate the plugin dependency graph and return framework plugins sorted in
 * safe execution order.
 *
 * Performs the following validations before sorting:
 * - All declared dependencies are present in the `plugins` array.
 * - Every plugin defines at least one lifecycle method
 *   (`setupMiddleware`, `setupRoutes`, `setupPost`, or `setup`).
 * - `setup()`-only plugins are standalone-only and logged as an informational
 *   message (they are not framework-managed).
 * - Cross-phase dependency violations are rejected: a dependency's earliest
 *   active lifecycle phase must be <= the dependent's earliest phase (e.g. a
 *   `setupRoutes`-only plugin cannot depend on a `setupPost`-only plugin).
 *
 * Standalone (`setup()`-only) plugins are excluded from the returned array
 * because the framework does not call their lifecycle methods.
 *
 * @param plugins - The full array of `SlingshotPlugin` objects passed to
 *   `createApp()`.
 * @returns A new array containing only framework-participating plugins, sorted
 *   so that each plugin's dependencies appear before it.
 * @throws {Error} On circular dependencies, missing dependencies, plugins with
 *   no lifecycle methods, or cross-phase dependency violations.
 */
export function validateAndSortPlugins(plugins: SlingshotPlugin[]): SlingshotPlugin[] {
  if (plugins.length === 0) return [];

  const pluginNames = new Set<string>();
  const seenPluginNames = new Set<string>();
  const nameToPlugin = new Map(plugins.map(p => [p.name, p]));

  for (const plugin of plugins) {
    if (seenPluginNames.has(plugin.name)) {
      throw new Error(
        `[slingshot] Duplicate plugin name "${plugin.name}" found in the plugins array. Plugin names must be unique per app instance.`,
      );
    }
    seenPluginNames.add(plugin.name);
    pluginNames.add(plugin.name);
  }

  for (const plugin of plugins) {
    // Validate all declared dependencies are present
    for (const dep of plugin.dependencies ?? []) {
      if (!pluginNames.has(dep)) {
        throw new Error(
          `[slingshot] Plugin "${plugin.name}" declares dependency "${dep}" but it is not in the plugins array.`,
        );
      }
    }
    // Each plugin must define at least one lifecycle method
    if (!plugin.setupMiddleware && !plugin.setupRoutes && !plugin.setupPost && !plugin.setup) {
      throw new Error(
        `[slingshot] Plugin "${plugin.name}" must define at least one of: setupMiddleware, setupRoutes, setupPost, or setup.`,
      );
    }
    // setup()-only plugins are standalone-only — the framework skips them
    if (!plugin.setupMiddleware && !plugin.setupRoutes && !plugin.setupPost && plugin.setup) {
      console.info(
        `[slingshot] Plugin "${plugin.name}" defines only setup() — standalone-only, skipped by framework. Use setupMiddleware(), setupRoutes(), or setupPost() for framework integration.`,
      );
    }
  }

  // Cross-phase dependency validation
  for (const plugin of plugins) {
    const pluginPhase = getEarliestPhase(plugin);
    if (pluginPhase === 3) continue; // standalone-only: no framework phase to validate
    for (const depName of plugin.dependencies ?? []) {
      const dep = nameToPlugin.get(depName);
      if (!dep)
        throw new Error(
          `[slingshot] Plugin dependency "${depName}" not found during cross-phase validation.`,
        );
      const depPhase = getEarliestPhase(dep);
      if (depPhase > pluginPhase) {
        throw new Error(
          `[slingshot] Plugin "${plugin.name}" (earliest phase: ${PHASE_NAMES[pluginPhase]}) ` +
            `depends on "${depName}" (earliest phase: ${PHASE_NAMES[depPhase]}). ` +
            `A dependency's earliest phase must be ≤ the dependent's earliest phase.`,
        );
      }
    }
  }

  // Topological sort — only include plugins that participate in at least one framework phase
  const frameworkPlugins = plugins.filter(participatesInFrameworkLifecycle);
  return topologicalSort(frameworkPlugins);
}

// ---------------------------------------------------------------------------
// Plugin lifecycle execution
// ---------------------------------------------------------------------------

/**
 * Run the `setupMiddleware` phase for all sorted plugins in dependency order.
 *
 * Called after framework middleware (request ID, CORS, rate limit, etc.) and
 * before tenant resolution, so plugins in this phase can register auth and
 * other cross-cutting middleware that the tenant middleware may depend on.
 *
 * @param sortedPlugins - Plugins in topological order as returned by
 *   {@link validateAndSortPlugins}.
 * @param app - The `OpenAPIHono` app instance to register middleware on.
 * @param frameworkConfig - Resolved framework configuration passed to each plugin.
 * @param bus - The instance-owned `SlingshotEventBus` passed to each plugin.
 * @param tracer - Optional OTel tracer. When provided, each plugin call is
 *   wrapped in a span named `slingshot.plugin.${plugin.name}.setupMiddleware`.
 * @returns A promise that resolves after all `setupMiddleware` callbacks complete.
 * @throws Re-throws any error thrown by a plugin's `setupMiddleware` callback.
 */
export async function runPluginMiddleware(
  sortedPlugins: SlingshotPlugin[],
  app: OpenAPIHono<AppEnv>,
  frameworkConfig: FrameworkConfig,
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  tracer?: Tracer,
): Promise<void> {
  for (const plugin of sortedPlugins) {
    const setupMiddleware = plugin.setupMiddleware?.bind(plugin);
    if (setupMiddleware) {
      if (tracer) {
        await withSpan(tracer, `slingshot.plugin.${plugin.name}.setupMiddleware`, async span => {
          span.setAttribute('slingshot.plugin.name', plugin.name);
          span.setAttribute('slingshot.plugin.phase', 'setupMiddleware');
          span.setAttribute('slingshot.plugin.dependency_count', plugin.dependencies?.length ?? 0);
          await setupMiddleware({ app, config: frameworkConfig, bus, events });
        });
      } else {
        await setupMiddleware({ app, config: frameworkConfig, bus, events });
      }
    }
  }
}

/**
 * Run the `setupRoutes` phase for all sorted plugins in dependency order.
 *
 * Called after tenant resolution middleware is mounted, so route handlers
 * registered here have access to `c.get('tenantId')` and all auth context.
 * This is the correct phase for registering HTTP routes, OpenAPI endpoints,
 * and WebSocket upgrade handlers.
 *
 * @param sortedPlugins - Plugins in topological order as returned by
 *   {@link validateAndSortPlugins}.
 * @param app - The `OpenAPIHono` app instance to register routes on.
 * @param frameworkConfig - Resolved framework configuration passed to each plugin.
 * @param bus - The instance-owned `SlingshotEventBus` passed to each plugin.
 * @param tracer - Optional OTel tracer. When provided, each plugin call is
 *   wrapped in a span named `slingshot.plugin.${plugin.name}.setupRoutes`.
 * @returns A promise that resolves after all `setupRoutes` callbacks complete.
 * @throws Re-throws any error thrown by a plugin's `setupRoutes` callback.
 */
export async function runPluginRoutes(
  sortedPlugins: SlingshotPlugin[],
  app: OpenAPIHono<AppEnv>,
  frameworkConfig: FrameworkConfig,
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  tracer?: Tracer,
): Promise<void> {
  for (const plugin of sortedPlugins) {
    const setupRoutes = plugin.setupRoutes?.bind(plugin);
    if (setupRoutes) {
      if (tracer) {
        await withSpan(tracer, `slingshot.plugin.${plugin.name}.setupRoutes`, async span => {
          span.setAttribute('slingshot.plugin.name', plugin.name);
          span.setAttribute('slingshot.plugin.phase', 'setupRoutes');
          span.setAttribute('slingshot.plugin.dependency_count', plugin.dependencies?.length ?? 0);
          await setupRoutes({ app, config: frameworkConfig, bus, events });
        });
      } else {
        await setupRoutes({ app, config: frameworkConfig, bus, events });
      }
    }
  }
}

/**
 * Run the `setupPost` phase for all sorted plugins in dependency order.
 *
 * Called after all routes and error handlers are mounted.  Use this phase for
 * one-time initialisation that requires all routes to be registered first:
 * entity discovery, background task subscriptions, event bus listeners, and
 * any state that depends on the fully-assembled route graph.
 *
 * @param sortedPlugins - Plugins in topological order as returned by
 *   {@link validateAndSortPlugins}.
 * @param app - The fully-assembled `OpenAPIHono` app instance.
 * @param frameworkConfig - Resolved framework configuration passed to each plugin.
 * @param bus - The instance-owned `SlingshotEventBus` passed to each plugin.
 * @param tracer - Optional OTel tracer. When provided, each plugin call is
 *   wrapped in a span named `slingshot.plugin.${plugin.name}.setupPost`.
 * @returns A promise that resolves after all `setupPost` callbacks complete.
 * @throws Re-throws any error thrown by a plugin's `setupPost` callback.
 */
export async function runPluginPost(
  sortedPlugins: SlingshotPlugin[],
  app: OpenAPIHono<AppEnv>,
  frameworkConfig: FrameworkConfig,
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  tracer?: Tracer,
): Promise<void> {
  for (const plugin of sortedPlugins) {
    const setupPost = plugin.setupPost?.bind(plugin);
    if (setupPost) {
      if (tracer) {
        await withSpan(tracer, `slingshot.plugin.${plugin.name}.setupPost`, async span => {
          span.setAttribute('slingshot.plugin.name', plugin.name);
          span.setAttribute('slingshot.plugin.phase', 'setupPost');
          span.setAttribute('slingshot.plugin.dependency_count', plugin.dependencies?.length ?? 0);
          await setupPost({ app, config: frameworkConfig, bus, events });
        });
      } else {
        await setupPost({ app, config: frameworkConfig, bus, events });
      }
    }
  }
}

/**
 * Run `teardown()` for all plugins in reverse setup order (last-in, first-out).
 *
 * Every plugin's `teardown()` is called regardless of whether earlier teardowns
 * fail, ensuring best-effort cleanup across all plugins.  All errors are
 * collected and re-thrown together as an `AggregateError` if any teardowns fail.
 *
 * @param plugins - The full list of plugins (need not be pre-sorted — teardown
 *   uses `.toReversed()` on the provided order).
 * @returns A promise that resolves when all teardown callbacks have settled.
 * @throws {AggregateError} When one or more `teardown()` callbacks throw.  All
 *   individual errors are available on `err.errors`.
 */
export async function runPluginTeardown(plugins: SlingshotPlugin[]): Promise<void> {
  const errors: Error[] = [];
  for (const plugin of plugins.toReversed()) {
    try {
      await plugin.teardown?.();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `[slingshot] ${errors.length} plugin teardown(s) failed`);
  }
}

import { getContext } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  OrchestrationError,
  type OrchestrationRuntime,
  createOrchestrationRuntime,
} from '@lastshotlabs/slingshot-orchestration';
import { ORCHESTRATION_PLUGIN_KEY } from './context';
import { createSlingshotEventSink } from './eventSink';
import { createOrchestrationRouter } from './routes';
import type { ConfigurableOrchestrationPluginOptions } from './types';

/**
 * Create the Slingshot integration layer for the portable orchestration runtime.
 *
 * The plugin publishes the runtime through `ctx.pluginState`, bridges lifecycle events
 * onto `ctx.bus`, optionally mounts HTTP routes, and manages adapter startup/shutdown
 * when an adapter instance is provided instead of a pre-built runtime.
 */
export function createOrchestrationPlugin(
  options: ConfigurableOrchestrationPluginOptions,
): SlingshotPlugin {
  const workflows = options.workflows ?? [];
  const routes = options.routes ?? true;
  const routePrefix = options.routePrefix ?? '/orchestration';
  const routeMiddleware = options.routeMiddleware ?? [];
  const adminAuth = options.adminAuth;
  const providedRuntime = 'runtime' in options ? options.runtime : undefined;
  const providedAdapter = 'adapter' in options ? options.adapter : undefined;
  let runtime: OrchestrationRuntime | null = providedRuntime ?? null;

  return {
    name: ORCHESTRATION_PLUGIN_KEY,
    dependencies: [],
    setupRoutes({ app, bus }: PluginSetupContext) {
      if (!runtime) {
        if (!providedAdapter) {
          throw new OrchestrationError(
            'INVALID_CONFIG',
            'Orchestration plugin requires either a runtime or an adapter.',
          );
        }
        runtime = createOrchestrationRuntime({
          adapter: providedAdapter,
          tasks: options.tasks,
          workflows,
          eventSink: createSlingshotEventSink(bus),
        });
      }

      getContext(app).pluginState.set(ORCHESTRATION_PLUGIN_KEY, runtime);

      if (!routes) return;
      if (routeMiddleware.length === 0) {
        throw new OrchestrationError(
          'INVALID_CONFIG',
          'Orchestration routes require at least one routeMiddleware guard. Provide routeMiddleware or set routes: false.',
        );
      }

      const router = createOrchestrationRouter({
        runtime,
        routeMiddleware,
        adminAuth,
        tasks: options.tasks,
        workflows,
        resolveRequestContext: options.resolveRequestContext,
        authorizeRun: options.authorizeRun,
        adapter: providedAdapter,
      });
      app.route(routePrefix, router);
    },
    async setupPost() {
      if (providedAdapter) {
        await providedAdapter.start();
      }
    },
    async teardown() {
      if (providedAdapter) {
        await providedAdapter.shutdown();
      }
    },
  };
}

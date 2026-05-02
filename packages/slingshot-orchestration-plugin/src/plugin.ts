import { createConsoleLogger, getContext, publishPluginState } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  OrchestrationError,
  type OrchestrationRuntime,
  createOrchestrationRuntime,
} from '@lastshotlabs/slingshot-orchestration';
import { ORCHESTRATION_PLUGIN_KEY } from './context';
import { type SlingshotEventSink, createSlingshotEventSink } from './eventSink';
import { createOrchestrationRouter } from './routes';
import type { ConfigurableOrchestrationPluginOptions } from './types';

const logger = createConsoleLogger({ base: { component: 'slingshot-orchestration-plugin' } });

const DEFAULT_START_MAX_ATTEMPTS = 1;
const DEFAULT_START_BACKOFF_MS = 1_000;
const MAX_BACKOFF_CAP_MS = 30_000;

/**
 * Cached health snapshot returned by `createOrchestrationPlugin().getHealth()`.
 *
 * The plugin reports `degraded` until a provided adapter has started. Apps that
 * pass a prebuilt runtime are considered adapter-available immediately because
 * lifecycle ownership stays outside this plugin.
 */
export interface OrchestrationPluginHealth {
  /** Coarse plugin state suitable for admin health summaries. */
  readonly status: 'healthy' | 'degraded';
  /** `true` once the plugin-owned adapter has successfully started. */
  readonly adapterAvailable: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry adapter.start() with exponential backoff.
 *
 * @param adapter - The orchestration adapter to start.
 * @param maxAttempts - Maximum number of start attempts (default: 1 = no retry).
 * @param backoffMs - Base backoff delay in milliseconds.
 */
async function startAdapterWithRetry(
  adapter: { start(): Promise<void> },
  maxAttempts: number,
  backoffMs: number,
): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await adapter.start();
      return; // success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        const delay = Math.min(backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_CAP_MS);
        logger.warn(
          `adapter.start() attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastError ?? new Error('adapter.start() failed after all retries');
}

/**
 * Create the Slingshot integration layer for the portable orchestration runtime.
 *
 * The plugin publishes the runtime through `ctx.pluginState`, bridges lifecycle events
 * onto `ctx.bus`, optionally mounts HTTP routes, and manages adapter startup/shutdown
 * when an adapter instance is provided instead of a pre-built runtime.
 */
export function createOrchestrationPlugin(
  options: ConfigurableOrchestrationPluginOptions,
): SlingshotPlugin & { getHealth(): OrchestrationPluginHealth } {
  const workflows = options.workflows ?? [];
  const routes = options.routes ?? true;
  const routePrefix = options.routePrefix ?? '/orchestration';
  const routeMiddleware = options.routeMiddleware ?? [];
  const adminAuth = options.adminAuth;
  const providedRuntime = 'runtime' in options ? options.runtime : undefined;
  const providedAdapter = 'adapter' in options ? options.adapter : undefined;
  const startMaxAttempts = options.startMaxAttempts ?? DEFAULT_START_MAX_ATTEMPTS;
  const startBackoffMs = options.startBackoffMs ?? DEFAULT_START_BACKOFF_MS;
  let runtime: OrchestrationRuntime | null = providedRuntime ?? null;
  let eventSink: SlingshotEventSink | null = null;
  /** Tracks whether the adapter (when provided) has started successfully. */
  let adapterStarted = providedAdapter === undefined;

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
        eventSink = createSlingshotEventSink(bus);
        runtime = createOrchestrationRuntime({
          adapter: providedAdapter,
          tasks: options.tasks,
          workflows,
          eventSink,
        });
      }

      publishPluginState(getContext(app).pluginState, ORCHESTRATION_PLUGIN_KEY, runtime);

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
        routeTimeoutMs: options.routeTimeoutMs,
      });
      app.route(routePrefix, router);
    },
    async setupPost() {
      if (providedAdapter) {
        await startAdapterWithRetry(providedAdapter, startMaxAttempts, startBackoffMs);
        adapterStarted = true;
      }
    },
    async teardown() {
      try {
        if (providedAdapter) {
          await providedAdapter.shutdown();
        }
      } finally {
        if (eventSink) {
          eventSink.dispose();
          eventSink = null;
        }
      }
    },
    getHealth(): OrchestrationPluginHealth {
      const status: 'healthy' | 'degraded' = adapterStarted ? 'healthy' : 'degraded';
      return { status, adapterAvailable: adapterStarted };
    },
  };
}

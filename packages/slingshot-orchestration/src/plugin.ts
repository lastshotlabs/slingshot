import type { PluginSetupContext, SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  definePackage,
  provideCapability,
} from '@lastshotlabs/slingshot-core';
import {
  OrchestrationError,
  type OrchestrationRuntime,
  createOrchestrationRuntime,
} from '@lastshotlabs/slingshot-orchestration-engine';
import { ORCHESTRATION_PLUGIN_STATE_KEY } from './context';
import { type SlingshotEventSink, createSlingshotEventSink } from './eventSink';
import { OrchestrationRuntimeCap } from './public';
import { createOrchestrationRouter } from './routes';
import type { ConfigurableOrchestrationPluginOptions } from './types';

const logger = createConsoleLogger({ base: { component: 'slingshot-orchestration' } });

const DEFAULT_START_MAX_ATTEMPTS = 1;
const DEFAULT_START_BACKOFF_MS = 1_000;
const MAX_BACKOFF_CAP_MS = 30_000;

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
      return;
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
 * Create the Slingshot integration package for the portable orchestration runtime.
 *
 * Publishes the runtime through `OrchestrationRuntimeCap`, bridges lifecycle events
 * onto `ctx.bus`, optionally mounts HTTP routes, and manages adapter startup/shutdown
 * when an adapter instance is provided instead of a pre-built runtime.
 */
export function createOrchestrationPackage(
  options: ConfigurableOrchestrationPluginOptions,
): SlingshotPackageDefinition {
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

  // Long-lived Proxy view published through `OrchestrationRuntimeCap`.
  // Constructed once per package instance so consumers reading the cap at
  // different lifecycle phases observe a stable reference (===). The
  // framework calls `provider.resolve()` twice (setupMiddleware + setupPost)
  // and republishes the cap slot each time; returning the same Proxy from
  // both calls keeps identity stable. All access defers to the live
  // `runtime` ref; method access is bound to the live ref so destructured
  // references work; `has` reflects the live ref's surface; symbol/`then`
  // reads return `undefined` so capability publication and `await` probes
  // don't error before the runtime is wired.
  const runtimeTarget = Object.create(null) as OrchestrationRuntime;
  const runtimeView: OrchestrationRuntime = new Proxy<OrchestrationRuntime>(runtimeTarget, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (!runtime) {
        throw new Error(
          `[slingshot-orchestration] runtime.${String(property)} accessed before setupRoutes constructed it; resolve OrchestrationRuntimeCap from setupPost or later.`,
        );
      }
      const value = Reflect.get(runtime as object, property);
      return typeof value === 'function' ? value.bind(runtime) : value;
    },
    has(_target, property) {
      if (!runtime) return false;
      return Reflect.has(runtime as object, property);
    },
    ownKeys() {
      if (!runtime) return [];
      return Reflect.ownKeys(runtime as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!runtime) return undefined;
      return Reflect.getOwnPropertyDescriptor(runtime as object, property);
    },
  });

  return definePackage({
    name: ORCHESTRATION_PLUGIN_STATE_KEY,
    dependencies: [],
    capabilities: {
      provides: [
        // Always return the same long-lived `runtimeView` Proxy. The framework
        // calls `provider.resolve()` twice (once at `setupMiddleware`, once at
        // `setupPost`) and republishes the cap slot each time — returning a
        // single stable reference means consumers reading the cap at any
        // lifecycle phase observe `===` identity. Field access defers to the
        // live `runtime` and throws a clear error if reached before
        // setupRoutes has constructed it.
        provideCapability(OrchestrationRuntimeCap, () => runtimeView),
      ],
    },

    // Returns a Promise so tests can use `await … .resolves.toBeUndefined()`
    // against the success path and `… .rejects.toThrow(…)` against the
    // INVALID_CONFIG checks below. The hook contract is `() => void | Promise<void>`.
    async setupRoutes({ app, bus }: PluginSetupContext) {
      if (!runtime) {
        if (!providedAdapter) {
          throw new OrchestrationError(
            'INVALID_CONFIG',
            'Orchestration package requires either a runtime or an adapter.',
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
  });
}

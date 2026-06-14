/**
 * Search package factory.
 *
 * Produces a `SlingshotPackageDefinition` consumed via `createApp({ packages: [...] })`.
 *
 * Lifecycle:
 * 1. `setupMiddleware` — registers internal search events on the framework bus.
 * 2. `setupRoutes`     — mounts per-entity search, suggest, federated, and admin routers.
 * 3. `setupPost`       — discovers searchable entities, initializes indexes, subscribes
 *                        to entity CRUD events for eventual sync, publishes the runtime
 *                        through pluginState (legacy) and the `SearchRuntimeCap` capability.
 * 4. `teardown`        — flushes pending syncs and disconnects providers.
 */
import type {
  Logger,
  MetricsEmitter,
  PluginSetupContext,
  ResolvedEntityConfig,
  SearchPluginRuntime,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  SEARCH_PLUGIN_STATE_KEY,
  createNoopMetricsEmitter,
  defineEvent,
  definePackage,
  getContextOrNull,
  getPluginState,
  noopLogger,
  publishPluginState,
  validateAdapterShape,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEventSyncManager } from './eventSync';
import type { EventSyncManager } from './eventSync';
import { SearchRuntimeCap } from './public';
import { createAdminRouter } from './routes/admin';
import { createFederatedRouter } from './routes/federated';
import { SEARCH_ROUTES } from './routes/index';
import { createSearchRouter } from './routes/search';
import { createSuggestRouter } from './routes/suggest';
import { createSearchManager } from './searchManager';
import { createSearchTransformRegistry } from './transformRegistry';
import type { SearchPluginConfig } from './types/config';
import { searchPluginConfigSchema } from './types/config';

/**
 * Create the slingshot search package.
 *
 * Provides config-driven indexing and querying for entities registered through
 * the framework entity registry. The package itself owns no entities — it
 * discovers them at boot via the registry — so the `definePackage` input has
 * empty `entities: []` and `domains: []` arrays; all route mounting happens
 * imperatively in `setupRoutes`.
 *
 * @param rawConfig - Plugin configuration validated against `searchPluginConfigSchema`.
 * @returns A `SlingshotPackageDefinition` ready to pass to `createApp({ packages })`.
 */
export function createSearchPackage(
  rawConfig: SearchPluginConfig,
  options?: { logger?: Logger },
): SlingshotPackageDefinition {
  const config = validatePluginConfig('slingshot-search', rawConfig, searchPluginConfigSchema);
  const logger: Logger = options?.logger ?? noopLogger;

  if (config.adminGate) {
    validateAdapterShape('slingshot-search', 'adminGate', config.adminGate, ['verifyRequest']);
  }

  const transformRegistry = createSearchTransformRegistry();
  if (config.transforms) {
    for (const [name, fn] of Object.entries(config.transforms)) {
      transformRegistry.register(name, fn);
    }
  }

  // Lazy metrics emitter resolution — see plugin-factory note in the original
  // implementation. Constructed before the framework context exists.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  const searchManager = createSearchManager({
    pluginConfig: config,
    transformRegistry,
    metrics: metricsProxy,
    logger,
  });

  let eventSyncManager: EventSyncManager | undefined;
  let runtime: SearchPluginRuntime | undefined;

  return definePackage({
    name: 'slingshot-search',
    dependencies: [],
    capabilities: {
      provides: [
        {
          capability: SearchRuntimeCap,
          // Return a Proxy: the framework eagerly resolves capability values
          // at setupMiddleware time, before our setupPost populates the
          // runtime. Field access throws a clear error if reached before
          // setupPost has run.
          resolve() {
            const target: SearchPluginRuntime = Object.create(null) as SearchPluginRuntime;
            return new Proxy(target, {
              get(_target, prop, receiver) {
                if (typeof prop === 'symbol' || prop === 'then') return undefined;
                if (!runtime) {
                  throw new Error(
                    `[slingshot-search] runtime.${String(prop)} accessed before setupPost completed; resolve SearchRuntimeCap from setupPost or later.`,
                  );
                }
                return Reflect.get(runtime, prop, receiver);
              },
            });
          },
        },
      ],
    },

    setupMiddleware({ events }: PluginSetupContext) {
      if (!events.get('search:sync.failed')) {
        events.register(
          defineEvent('search:sync.failed', {
            ownerPlugin: SEARCH_PLUGIN_STATE_KEY,
            exposure: ['internal'],
            resolveScope() {
              return null;
            },
          }),
        );
      }
      if (!events.get('search:sync.dead')) {
        events.register(
          defineEvent('search:sync.dead', {
            ownerPlugin: SEARCH_PLUGIN_STATE_KEY,
            exposure: ['internal'],
            resolveScope() {
              return null;
            },
          }),
        );
      }
      if (!events.get('search:dlq.evicted')) {
        events.register(
          defineEvent('search:dlq.evicted', {
            ownerPlugin: SEARCH_PLUGIN_STATE_KEY,
            exposure: ['internal'],
            resolveScope() {
              return null;
            },
          }),
        );
      }
      if (!events.get('search:geoTransform.skipped')) {
        events.register(
          defineEvent('search:geoTransform.skipped', {
            ownerPlugin: SEARCH_PLUGIN_STATE_KEY,
            exposure: ['internal'],
            resolveScope() {
              return null;
            },
          }),
        );
      }
    },

    setupRoutes({ app, config: frameworkConfig }: PluginSetupContext) {
      const mountPath = config.mountPath ?? '/search';
      const disabled = new Set(config.disableRoutes ?? []);

      if (!disabled.has(SEARCH_ROUTES.SEARCH)) {
        app.route(mountPath, createSearchRouter(searchManager, config));
      }
      if (!disabled.has(SEARCH_ROUTES.SUGGEST)) {
        app.route(mountPath, createSuggestRouter(searchManager, config));
      }
      if (!disabled.has(SEARCH_ROUTES.FEDERATED)) {
        app.route(mountPath, createFederatedRouter(searchManager, config));
      }
      if (!disabled.has(SEARCH_ROUTES.ADMIN) && config.adminGate) {
        app.route(mountPath, createAdminRouter(searchManager, config, frameworkConfig.storeInfra));
      } else if (!disabled.has(SEARCH_ROUTES.ADMIN) && !config.adminGate) {
        logger.warn(
          '[slingshot-search] Admin routes not mounted — set config.adminGate to enable index management endpoints.',
        );
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      const ctx = getContextOrNull(app);
      if (ctx) resolvedMetricsEmitter = ctx.metricsEmitter;

      const entityRegistry = frameworkConfig.entityRegistry;
      const searchableEntities: ReadonlyArray<ResolvedEntityConfig> = entityRegistry.filter(
        e => !!e.search,
      );

      if (searchableEntities.length === 0) {
        logger.warn(
          '[slingshot-search] entityRegistry is present but contains no entities with search config. ' +
            'No config-driven indexes will be created.',
        );
      }

      await searchManager.initialize(searchableEntities);

      eventSyncManager = createEventSyncManager({
        pluginConfig: config,
        searchManager,
        transformRegistry,
        bus,
        events,
        metrics: metricsProxy,
      });

      const eventBusEntities = searchableEntities.filter(e => e.search?.syncMode === 'event-bus');
      if (eventBusEntities.length > 0) {
        eventSyncManager.subscribeConfigEntities(eventBusEntities);
      }

      runtime = {
        async ensureConfigEntity(entity: ResolvedEntityConfig): Promise<void> {
          await searchManager.ensureConfigEntity(entity);
          eventSyncManager?.subscribeConfigEntity(entity);
        },
        getSearchClient(entityStorageName: string) {
          const indexName = searchManager.getIndexName(entityStorageName);
          if (!indexName) return null;
          return searchManager.getSearchClient(entityStorageName);
        },
      };

      // Bridge period: in-tree consumers (notably the framework's
      // `createContextStoreInfra` in `src/framework/persistence/`) still read
      // the runtime via `getPluginState(app).get(SEARCH_PLUGIN_STATE_KEY)` /
      // `getSearchPluginRuntime(app)`. Until those callers migrate to
      // `ctx.capabilities.require(SearchRuntimeCap)`, this publish must stay.
      // Remove alongside the SEARCH_PLUGIN_STATE_KEY export in the next major.
      publishPluginState(getPluginState(app), SEARCH_PLUGIN_STATE_KEY, runtime);
    },

    async teardown() {
      if (eventSyncManager) {
        await eventSyncManager.teardown();
        eventSyncManager = undefined;
      }
      await searchManager.teardown();
    },
  });
}

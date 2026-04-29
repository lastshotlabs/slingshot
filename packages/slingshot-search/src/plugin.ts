/**
 * Search plugin factory.
 *
 * Creates a `SlingshotPlugin` that provides enterprise search capabilities.
 * The plugin lifecycle:
 *
 * 1. **setupMiddleware**: Connects search providers and stores references
 *    for downstream use by routes and other plugins.
 * 2. **setupRoutes**: Mounts per-entity search routes, suggest routes,
 *    federated search, and admin index management routes.
 * 3. **setupPost**: Discovers entities with `search` config via the entity
 *    registry, initializes the search manager (ensures indexes), subscribes
 *    to entity CRUD events for eventual-sync entities, and registers
 *    client-safe SSE events.
 * 4. **teardown**: Flushes pending syncs and disconnects all providers.
 */
import type {
  Logger,
  MetricsEmitter,
  PluginSetupContext,
  ResolvedEntityConfig,
  SearchPluginRuntime,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  SEARCH_PLUGIN_STATE_KEY,
  createNoopMetricsEmitter,
  defineEvent,
  getContextOrNull,
  getPluginState,
  noopLogger,
  publishPluginState,
  validateAdapterShape,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEventSyncManager } from './eventSync';
import type { EventSyncManager } from './eventSync';
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
 * Create the slingshot search plugin.
 *
 * Wires provider connections, mounts search/suggest/federated/admin routes,
 * discovers searchable entities from the entity registry, creates/updates
 * indexes on startup, and subscribes to entity CRUD events for eventual sync.
 *
 * Plugin lifecycle:
 * 1. `setupMiddleware` — reserved for future request-level concerns.
 * 2. `setupRoutes` — mounts per-entity search routes at `config.mountPath`
 *    (default `'/search'`). Admin routes are only mounted when `config.adminGate`
 *    is set.
 * 3. `setupPost` — discovers entities, initializes indexes, subscribes to
 *    event-bus for `syncMode: 'event-bus'` entities, and registers client-safe
 *    SSE events.
 * 4. `teardown` — flushes pending syncs and disconnects all providers.
 *
 * @param rawConfig - Plugin configuration validated against
 *   `searchPluginConfigSchema`. At least one provider must be configured.
 * @returns A `SlingshotPlugin` with name `'slingshot-search'` ready to pass to
 *   `createApp()`.
 *
 * @throws {Error} If `rawConfig` fails Zod schema validation.
 * @throws {Error} If `config.adminGate` is provided but missing `verifyRequest`.
 *
 * @example
 * ```ts
 * import { createSearchPlugin } from '@lastshotlabs/slingshot-search';
 *
 * const search = createSearchPlugin({
 *   providers: {
 *     default: { provider: 'meilisearch', url: 'http://localhost:7700', apiKey: 'key' },
 *   },
 * });
 *
 * const { app } = await createApp({
 *   routesDir: import.meta.dir + '/routes',
 *   plugins: [search],
 * });
 * ```
 */
export function createSearchPlugin(
  rawConfig: SearchPluginConfig,
  options?: { logger?: Logger },
): SlingshotPlugin {
  // Zod schema validation — catches missing/mistyped fields at construction time
  const config = validatePluginConfig('slingshot-search', rawConfig, searchPluginConfigSchema);

  const logger: Logger = options?.logger ?? noopLogger;

  // Validate adminGate adapter shape if present
  if (config.adminGate) {
    validateAdapterShape('slingshot-search', 'adminGate', config.adminGate, ['verifyRequest']);
  }

  const transformRegistry = createSearchTransformRegistry();

  // Register caller-provided transforms on the internal registry
  if (config.transforms) {
    for (const [name, fn] of Object.entries(config.transforms)) {
      transformRegistry.register(name, fn);
    }
  }

  // The unified metrics emitter is owned by the framework context and not
  // available until `setupPost` runs (the manager is constructed here at
  // plugin-factory time, before the app exists). We resolve it lazily via
  // the indirection below so the manager doesn't need a re-construction.
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

  // Event sync manager — created lazily in setupPost
  let eventSyncManager: EventSyncManager | undefined;

  return {
    name: 'slingshot-search',
    dependencies: [],

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
      // Provider connection happens during setupPost (after entity discovery).
      // Middleware phase is reserved for future request-level concerns
      // (e.g. search-related request middleware).
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
      // Resolve the framework-owned metrics emitter so the search manager and
      // event sync manager can publish counters/gauges/timings on hot paths.
      // The proxy above ensures the plugin-factory-time manager construction
      // sees this emitter without a second factory call.
      const ctx = getContextOrNull(app);
      if (ctx) resolvedMetricsEmitter = ctx.metricsEmitter;

      // Discover entities with search config via entity registry.
      // The framework attaches the entity registry during bootstrap, and
      // owner plugins populate it during setupMiddleware/setupRoutes.
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

      // Initialize the search manager with discovered entities
      await searchManager.initialize(searchableEntities);

      // Create the event sync manager for batched event-bus sync
      eventSyncManager = createEventSyncManager({
        pluginConfig: config,
        searchManager,
        transformRegistry,
        bus,
        events,
        metrics: metricsProxy,
      });

      // Subscribe to events for config-driven entities with event-bus sync
      const eventBusEntities = searchableEntities.filter(e => e.search?.syncMode === 'event-bus');
      if (eventBusEntities.length > 0) {
        eventSyncManager.subscribeConfigEntities(eventBusEntities);
      }

      const runtime: SearchPluginRuntime = {
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
      publishPluginState(getPluginState(app), SEARCH_PLUGIN_STATE_KEY, runtime);
    },

    async teardown() {
      // Teardown event sync manager (flush remaining, unsubscribe all)
      if (eventSyncManager) {
        await eventSyncManager.teardown();
        eventSyncManager = undefined;
      }

      // Teardown the search manager (disconnects providers, clears state)
      await searchManager.teardown();
    },
  };
}

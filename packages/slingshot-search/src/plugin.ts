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
  PluginSetupContext,
  ResolvedEntityConfig,
  SearchPluginRuntime,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  SEARCH_PLUGIN_STATE_KEY,
  defineEvent,
  getPluginState,
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
export function createSearchPlugin(rawConfig: SearchPluginConfig): SlingshotPlugin {
  // Zod schema validation — catches missing/mistyped fields at construction time
  const config = validatePluginConfig('slingshot-search', rawConfig, searchPluginConfigSchema);

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

  const searchManager = createSearchManager({
    pluginConfig: config,
    transformRegistry,
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
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      // Discover entities with search config via entity registry.
      // The framework attaches the entity registry during bootstrap, and
      // owner plugins populate it during setupMiddleware/setupRoutes.
      const entityRegistry = frameworkConfig.entityRegistry;
      const searchableEntities: ReadonlyArray<ResolvedEntityConfig> = entityRegistry.filter(
        e => !!e.search,
      );

      if (searchableEntities.length === 0) {
        console.warn(
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
      getPluginState(app).set(SEARCH_PLUGIN_STATE_KEY, runtime);
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

import type {
  Logger,
  PermissionsState,
  PluginSetupContext,
  SlingshotEvents,
  SlingshotPlugin,
  StorageAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  defineEvent,
  getPermissionsStateOrNull,
  getPluginState,
  noopLogger,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { resolveStorageAdapter } from './adapters/index';
import type { S3CircuitBreakerHealth, S3StorageAdapter } from './adapters/s3';
import { assetsPluginConfigSchema } from './config.schema';
import { createMemoryImageCache } from './image/cache';
import { resolveImageConfig } from './image/serve';
import type { ImageCacheAdapter } from './image/types';
import { assetManifest } from './manifest/assetManifest';
import { createAssetsManifestRuntime } from './manifest/runtime';
import {
  type OrphanedKeyRegistry,
  createOrphanedKeyRegistry,
} from './middleware/deleteStorageFile';
import {
  ASSETS_PLUGIN_STATE_KEY,
  type AssetAdapter,
  type AssetsHealth,
  type AssetsHealthDetails,
  type AssetsPluginConfig,
  type AssetsPluginState,
  type OrphanedKeyRecord,
  type StorageAdapterRef,
} from './types';

function isImageCacheAdapter(value: unknown): value is ImageCacheAdapter {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'get') === 'function' &&
    typeof Reflect.get(value, 'set') === 'function'
  );
}

function isS3StorageAdapter(value: StorageAdapter): value is S3StorageAdapter {
  return typeof (value as Partial<S3StorageAdapter>).getCircuitBreakerHealth === 'function';
}

function isStorageAdapterRef(
  value: StorageAdapter | StorageAdapterRef,
): value is StorageAdapterRef {
  return typeof (value as Partial<StorageAdapter>).put !== 'function';
}

function describeStorageKind(
  ref: StorageAdapter | StorageAdapterRef,
): AssetsHealthDetails['storageAdapter'] {
  if (isStorageAdapterRef(ref)) return ref.adapter;
  return 'custom';
}

/**
 * Create the manifest-driven assets plugin.
 *
 * Asset persistence is owned by `assetManifest`. Package-specific runtime
 * behavior such as presign operations, image serving, TTL decoration, and
 * delete-to-storage cleanup is resolved through the manifest runtime.
 *
 * @param rawConfig - Assets plugin configuration.
 * @returns A Slingshot plugin instance for app registration.
 */
export function createAssetsPlugin(
  rawConfig: AssetsPluginConfig,
  options?: {
    /** Structured logger handle. Defaults to noopLogger. */
    logger?: Logger;
  },
): SlingshotPlugin & {
  getHealth(): AssetsHealth;
  /**
   * Snapshot of orphaned-storage records the delete-cascade middleware has
   * recorded since startup (or `since`, when provided). The list is bounded
   * in memory; durable retention is the operator's responsibility via
   * `onOrphanedKey`.
   */
  listOrphanedKeys(since?: Date): ReadonlyArray<OrphanedKeyRecord>;
} {
  const config = Object.freeze(
    validatePluginConfig(ASSETS_PLUGIN_STATE_KEY, rawConfig, assetsPluginConfigSchema),
  );
  const mountPath = config.mountPath ?? '/assets';
  const logger: Logger = options?.logger ?? noopLogger;

  const storage = resolveStorageAdapter(config.storage, {
    storageRetryAttempts: config.storageRetryAttempts,
    ...(config.storageCircuitBreakerThreshold !== undefined
      ? { storageCircuitBreakerThreshold: config.storageCircuitBreakerThreshold }
      : {}),
    ...(config.storageCircuitBreakerCooldownMs !== undefined
      ? { storageCircuitBreakerCooldownMs: config.storageCircuitBreakerCooldownMs }
      : {}),
  });
  const imageConfig = resolveImageConfig(config.image);
  const imageCache =
    imageConfig != null
      ? isImageCacheAdapter(config.image?.cache)
        ? config.image.cache
        : (() => {
            if (config.image?.cache !== undefined) {
              logger.warn(
                '[slingshot-assets] image.cache is not a valid ImageCacheAdapter — falling back to in-memory cache. ' +
                  'This cache is not shared across processes.',
              );
            }
            const cacheOpts: { maxEntries?: number; ttlMs?: number } = {};
            if (config.image?.cacheMaxEntries !== undefined) {
              cacheOpts.maxEntries = config.image.cacheMaxEntries;
            }
            if (config.image?.cacheTtlMs !== undefined) {
              cacheOpts.ttlMs = config.image.cacheTtlMs;
            }
            return createMemoryImageCache(cacheOpts);
          })()
      : null;

  type LazyMiddleware = { handler: import('hono').MiddlewareHandler };
  // The manifest runtime is responsible for wiring the real handler before
  // routes mount. If it never does, we throw at setupPost rather than letting
  // entity deletes silently orphan storage objects (unless the operator has
  // explicitly opted in to orphans via `allowOrphanedStorage`).
  let deleteMiddlewareWired = false;
  const allowOrphanedStorage = config.allowOrphanedStorage === true;
  const unwiredHandler: import('hono').MiddlewareHandler = allowOrphanedStorage
    ? async (_c, next) => next()
    : async () => {
        throw new Error(
          '[slingshot-assets] delete cascade fired but storage-delete middleware was never wired. ' +
            'This indicates a manifest runtime bug — refusing to silently orphan storage objects.',
        );
      };
  const deleteStorageFileRef: LazyMiddleware = { handler: unwiredHandler };

  let assetAdapterRef: AssetAdapter | undefined;
  let innerPlugin: EntityPlugin | undefined;

  const orphanRegistry: OrphanedKeyRegistry = createOrphanedKeyRegistry();
  // `events` is populated lazily during setupMiddleware once the host has
  // initialised the registry-backed publisher. The manifest runtime captures
  // a getter so the delete-cascade middleware can be wired before the
  // publisher exists.
  let publisher: SlingshotEvents | undefined;

  const manifestRuntime = createAssetsManifestRuntime({
    config,
    storage,
    imageCache,
    imageConfig,
    logger,
    orphanRegistry,
    getEvents: () => publisher,
    setDeleteStorageMiddleware(handler) {
      deleteStorageFileRef.handler = handler;
      deleteMiddlewareWired = true;
    },
    setAssetAdapter(adapter) {
      assetAdapterRef = adapter;
    },
  });

  const storageKind = describeStorageKind(config.storage);
  const storageConfigured = config.storage != null;

  function readCircuitBreakerHealth(): S3CircuitBreakerHealth | undefined {
    if (!isS3StorageAdapter(storage)) return undefined;
    return storage.getCircuitBreakerHealth();
  }

  function getHealth(): AssetsHealth {
    const breaker = readCircuitBreakerHealth();
    const cacheHealth = imageCache?.getHealth?.();

    const details: AssetsHealthDetails = {
      storageAdapter: storageKind,
      storageConfigured,
      ...(breaker
        ? {
            storageCircuitBreaker: {
              state: breaker.state,
              consecutiveFailures: breaker.consecutiveFailures,
              openedAt: breaker.openedAt,
              nextProbeAt: breaker.nextProbeAt,
            },
          }
        : {}),
      ...(cacheHealth
        ? {
            imageCache: {
              size: cacheHealth.size,
              evictionCount: cacheHealth.evictionCount,
              ...(cacheHealth.ttlEvictionCount !== undefined
                ? { ttlEvictionCount: cacheHealth.ttlEvictionCount }
                : {}),
            },
          }
        : {}),
    };

    let status: AssetsHealth['status'] = 'healthy';
    if (!storageConfigured) status = 'unhealthy';
    if (breaker?.state === 'half-open') status = 'degraded';
    if (breaker?.state === 'open') status = 'unhealthy';

    return { status, details };
  }

  return {
    name: ASSETS_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth', 'slingshot-permissions'],
    getHealth,
    listOrphanedKeys(since?: Date) {
      return orphanRegistry.listOrphanedKeys(since);
    },

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      // Register the operational events the assets plugin emits before any
      // route can fire them (delete-cascade-cleanup, presign retry exhaustion).
      if (!events.get('asset:storageDeleteFailed')) {
        events.register(
          defineEvent('asset:storageDeleteFailed', {
            ownerPlugin: ASSETS_PLUGIN_STATE_KEY,
            exposure: ['internal'],
            resolveScope() {
              return null;
            },
          }),
        );
      }
      // Hand the publisher to the manifest runtime via the captured getter.
      publisher = events;

      const permissions: PermissionsState =
        getPermissionsStateOrNull(getPluginState(app)) ??
        (() => {
          throw new Error(
            '[slingshot-assets] No permissions available. Register createPermissionsPlugin() ' +
              'before this plugin.',
          );
        })();

      innerPlugin = createEntityPlugin({
        name: ASSETS_PLUGIN_STATE_KEY,
        mountPath,
        manifest: assetManifest,
        manifestRuntime,
        middleware: {
          deleteStorageFile: async (c, next) => deleteStorageFileRef.handler(c, next),
        },
        permissions,
      });

      await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus, events });
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      if (assetAdapterRef) {
        const state: AssetsPluginState = Object.freeze({
          assets: assetAdapterRef,
          storage,
          config,
        });
        getPluginState(app).set(ASSETS_PLUGIN_STATE_KEY, state);
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      const hasAssetEntities = Object.keys(assetManifest.entities ?? {}).length > 0;
      if (!deleteMiddlewareWired && hasAssetEntities) {
        if (allowOrphanedStorage) {
          logger.warn(
            '[slingshot-assets] storage-delete middleware was not wired and ' +
              '`allowOrphanedStorage: true` is set. Asset deletes will leave storage objects ' +
              'behind. Ensure cleanup runs elsewhere.',
          );
        } else {
          const error = new Error(
            '[slingshot-assets] storage-delete middleware was not wired by the manifest runtime. ' +
              'Asset deletes would orphan storage objects. Refusing to start. ' +
              'Set `allowOrphanedStorage: true` to opt out (e.g. during a migration).',
          );
          (error as Error & { code?: string }).code = 'ASSETS_DELETE_MIDDLEWARE_MISSING';
          throw error;
        }
      }
    },
  };
}

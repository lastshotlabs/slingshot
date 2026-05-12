/**
 * Assets package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts the `Asset` entity through
 * the `definePackage` authoring path, wires storage / image cache / S3 circuit
 * breaker, registers the storage-delete middleware that cascades to the object
 * store on entity delete, and publishes capabilities for the runtime, health
 * snapshot, and orphaned-key recovery API.
 *
 * Every adapter ref, middleware closure, and registry instance is owned by the
 * factory's closure (Rule 3) — multiple package instances in the same process
 * do not share state.
 */
import type { MiddlewareHandler } from 'hono';
import type {
  Logger,
  PluginSetupContext,
  SlingshotEvents,
  SlingshotPackageDefinition,
  StorageAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  defineEvent,
  definePackage,
  noopLogger,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import {
  AssetsHealthCap,
  AssetsOrphanedKeysCap,
  AssetsRuntimeCap,
} from './public';
import { resolveStorageAdapter } from './adapters/index';
import type { S3CircuitBreakerHealth, S3StorageAdapter } from './adapters/s3';
import { assetsPluginConfigSchema } from './config.schema';
import { buildAssetsEntityModules } from './entities/modules';
import type { AssetsHandlerDeps } from './entities/runtime';
import { createMemoryImageCache } from './image/cache';
import { resolveImageConfig } from './image/serve';
import type { ImageCacheAdapter } from './image/types';
import {
  type OrphanedKeyRegistry,
  createDeleteStorageFileMiddleware,
  createOrphanedKeyRegistry,
} from './middleware/deleteStorageFile';
import {
  ASSETS_PLUGIN_STATE_KEY,
  type AssetAdapter,
  type AssetsHealth,
  type AssetsHealthDetails,
  type AssetsPluginConfig,
  type AssetsPluginState,
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
 * Optional non-JSON dependencies the assets package accepts at construction time.
 */
export interface AssetsPackageDeps {
  /** Structured logger handle. Defaults to {@link noopLogger}. */
  logger?: Logger;
}

/**
 * Create the assets package using the `definePackage` authoring path.
 *
 * The `Asset` entity is mounted through the package's `entities: [...]`
 * declaration; its adapter is TTL-wrapped inside the entity module's
 * `wiring.buildAdapter` callback and captured into the package's closure-owned
 * ref so the storage-delete middleware and the published capabilities all use
 * the same adapter instance per package.
 *
 * @param rawConfig - Assets package configuration.
 * @param deps - Optional non-JSON dependencies.
 * @returns A `SlingshotPackageDefinition` ready to pass to `createApp({ packages: [...] })`.
 */
export function createAssetsPackage(
  rawConfig: AssetsPluginConfig,
  deps: AssetsPackageDeps = {},
): SlingshotPackageDefinition {
  const config = Object.freeze(
    validatePluginConfig(ASSETS_PLUGIN_STATE_KEY, rawConfig, assetsPluginConfigSchema),
  );
  const logger: Logger = deps.logger ?? noopLogger;

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

  // Closure-owned adapter ref populated by the entity module's `wiring.buildAdapter`
  // callback during bootstrap. The storage-delete middleware, the custom-op
  // handlers (via `handlerDeps.getAssetAdapter`), and the published capabilities
  // all read through this ref.
  let assetAdapterRef: AssetAdapter | undefined;

  const orphanRegistry: OrphanedKeyRegistry = createOrphanedKeyRegistry();

  // `events` is populated lazily during `setupMiddleware` once the host has
  // initialised the registry-backed publisher. The delete-cascade middleware
  // captures the getter so it can emit `asset:storageDeleteFailed` once routes
  // start running.
  let publisher: SlingshotEvents | undefined;

  // Shared handler deps for the custom-op handlers (presignUpload, etc.).
  const handlerDeps: AssetsHandlerDeps = {
    config,
    storage,
    imageCache,
    imageConfig,
    logger,
    getAssetAdapter: () => assetAdapterRef,
    getEvents: () => publisher,
  };

  const { assetModule } = buildAssetsEntityModules({
    registryTtlSeconds: config.registryTtlSeconds,
    onAdapter: adapter => {
      assetAdapterRef = adapter;
    },
    handlerDeps,
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

  // The storage-delete middleware needs the asset adapter to look up the
  // storage key before the entity delete runs. Captured via `assetAdapterRef`
  // and dispatched lazily so it survives boot-order shifts. If the entity
  // module's `buildAdapter` hasn't run by the time a delete fires, the
  // middleware fails with a structured error rather than silently orphaning
  // storage objects.
  const allowOrphanedStorage = config.allowOrphanedStorage === true;
  const deleteStorageFile: MiddlewareHandler = async (c, next) => {
    const adapter = assetAdapterRef;
    if (!adapter) {
      if (allowOrphanedStorage) {
        return next();
      }
      throw new Error(
        '[slingshot-assets] delete cascade fired but storage-delete middleware adapter was not resolved. ' +
          'This indicates a package bootstrap bug — refusing to silently orphan storage objects.',
      );
    }
    const inner = createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: adapter,
      logger,
      events: publisher,
      orphanRegistry,
      ...(config.onOrphanedKey ? { onOrphanedKey: config.onOrphanedKey } : {}),
    });
    return inner(c, next);
  };

  return definePackage({
    name: ASSETS_PLUGIN_STATE_KEY,
    mountPath: config.mountPath ?? '/assets',
    dependencies: ['slingshot-auth', 'slingshot-permissions'],
    entities: [assetModule],
    middleware: {
      deleteStorageFile,
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async setupMiddleware({ events }: PluginSetupContext) {
      // Register the operational events the assets package emits before any
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
      // Hand the publisher to the runtime so the delete-cascade middleware can
      // emit through it on retry exhaustion.
      publisher = events;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async setupPost(_ctx: PluginSetupContext) {
      if (!assetAdapterRef) {
        // The entity module uses manual wiring and populates `assetAdapterRef`
        // inside `buildAdapter`. If we reach `setupPost` without it being
        // populated, the entity routes never mounted — surface that as an
        // error rather than silently no-op.
        if (allowOrphanedStorage) {
          logger.warn(
            '[slingshot-assets] storage-delete middleware was not wired and ' +
              '`allowOrphanedStorage: true` is set. Asset deletes will leave storage objects ' +
              'behind. Ensure cleanup runs elsewhere.',
          );
        } else {
          const error = new Error(
            '[slingshot-assets] storage-delete middleware was not wired by the entity bootstrap. ' +
              'Asset deletes would orphan storage objects. Refusing to start. ' +
              'Set `allowOrphanedStorage: true` to opt out (e.g. during a migration).',
          );
          (error as Error & { code?: string }).code = 'ASSETS_DELETE_MIDDLEWARE_MISSING';
          throw error;
        }
      }
    },

    capabilities: {
      provides: [
        provideCapability(AssetsRuntimeCap, () => {
          if (!assetAdapterRef) {
            throw new Error(
              '[slingshot-assets] AssetsRuntimeCap resolved before the asset adapter was captured',
            );
          }
          const state: AssetsPluginState = Object.freeze({
            assets: assetAdapterRef,
            storage,
            config,
          });
          return state;
        }),
        provideCapability(AssetsHealthCap, () => getHealth),
        provideCapability(AssetsOrphanedKeysCap, () => (since?: Date) =>
          orphanRegistry.listOrphanedKeys(since),
        ),
      ],
    },
  });
}

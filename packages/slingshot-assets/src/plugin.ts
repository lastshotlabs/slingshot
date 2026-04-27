import type {
  PermissionsState,
  PluginSetupContext,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  getPermissionsStateOrNull,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { resolveStorageAdapter } from './adapters/index';
import { assetsPluginConfigSchema } from './config.schema';
import { createMemoryImageCache } from './image/cache';
import { resolveImageConfig } from './image/serve';
import type { ImageCacheAdapter } from './image/types';
import { assetManifest } from './manifest/assetManifest';
import { createAssetsManifestRuntime } from './manifest/runtime';
import {
  ASSETS_PLUGIN_STATE_KEY,
  type AssetAdapter,
  type AssetsPluginConfig,
  type AssetsPluginState,
} from './types';

function isImageCacheAdapter(value: unknown): value is ImageCacheAdapter {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'get') === 'function' &&
    typeof Reflect.get(value, 'set') === 'function'
  );
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
export function createAssetsPlugin(rawConfig: AssetsPluginConfig): SlingshotPlugin {
  const config = Object.freeze(
    validatePluginConfig(ASSETS_PLUGIN_STATE_KEY, rawConfig, assetsPluginConfigSchema),
  );
  const mountPath = config.mountPath ?? '/assets';
  const storage = resolveStorageAdapter(config.storage, {
    storageRetryAttempts: config.storageRetryAttempts,
  });
  const imageConfig = resolveImageConfig(config.image);
  const imageCache =
    imageConfig != null
      ? isImageCacheAdapter(config.image?.cache)
        ? config.image.cache
        : createMemoryImageCache()
      : null;

  type LazyMiddleware = { handler: import('hono').MiddlewareHandler };
  const noop: import('hono').MiddlewareHandler = async (_c, next) => {
    console.warn(
      '[assets] delete cascade fired but no handler configured — storage file not deleted',
    );
    return next();
  };
  const deleteStorageFileRef: LazyMiddleware = { handler: noop };

  let assetAdapterRef: AssetAdapter | undefined;
  let innerPlugin: EntityPlugin | undefined;

  const manifestRuntime = createAssetsManifestRuntime({
    config,
    storage,
    imageCache,
    imageConfig,
    setDeleteStorageMiddleware(handler) {
      deleteStorageFileRef.handler = handler;
    },
    setAssetAdapter(adapter) {
      assetAdapterRef = adapter;
    },
  });

  return {
    name: ASSETS_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth', 'slingshot-permissions'],

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
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
    },
  };
}

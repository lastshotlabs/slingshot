/**
 * @lastshotlabs/slingshot-assets
 *
 * Entity-driven asset storage package for Slingshot.
 */

/**
 * Create the slingshot-assets plugin.
 */
export { createAssetsPlugin } from './plugin';
export { assetManifest } from './manifest/assetManifest';
export { ASSETS_PLUGIN_STATE_KEY } from './types';

export type {
  Asset,
  AssetAdapter,
  AssetsPluginConfig,
  AssetsPluginState,
  CreateAssetInput,
  ImageConfig,
  PresignedUrlConfig,
  StorageAdapterRef,
  UpdateAssetInput,
} from './types';

/**
 * Create an S3-compatible storage adapter.
 */
export { s3Storage, type S3StorageConfig } from './adapters/s3';

/**
 * Create a local-filesystem storage adapter.
 */
export { localStorage, type LocalStorageConfig } from './adapters/local';

/**
 * Create an in-memory storage adapter.
 */
export { memoryStorage } from './adapters/memory';

/**
 * Resolve a manifest-compatible storage adapter reference.
 */
export { resolveStorageAdapter } from './adapters/index';

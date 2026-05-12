/**
 * @lastshotlabs/slingshot-assets
 *
 * Entity-driven asset storage package for Slingshot.
 */
// --- Events (module augmentation — imported for side effects) ---
import './events';

/**
 * Create the slingshot-assets package.
 */
export { createAssetsPackage } from './plugin';
/**
 * Optional non-JSON dependencies accepted by {@link createAssetsPackage}.
 */
export type { AssetsPackageDeps } from './plugin';
/**
 * Provider-owned package contract and capabilities for cross-package consumers.
 */
export {
  Assets,
  AssetsHealthCap,
  AssetsOrphanedKeysCap,
  AssetsRuntimeCap,
} from './public';
/**
 * Plugin state key used to retrieve the assets runtime state from app context.
 */
export { ASSETS_PLUGIN_STATE_KEY } from './types';

/**
 * Public asset records, adapter contracts, plugin config, and storage input types.
 */
export type {
  Asset,
  AssetAdapter,
  AssetsHealth,
  AssetsHealthDetails,
  AssetsPluginConfig,
  AssetsPluginState,
  CreateAssetInput,
  ImageConfig,
  OrphanedKeyRecord,
  PresignedUrlConfig,
  StorageAdapterRef,
  UpdateAssetInput,
} from './types';

/**
 * Bounded in-memory orphan-key registry used for the recovery API.
 */
export type { OrphanedKeyRegistry } from './middleware/deleteStorageFile';
/**
 * Create a bounded in-memory registry for storage keys that need orphan cleanup.
 */
export { createOrphanedKeyRegistry } from './middleware/deleteStorageFile';

/**
 * Create an S3-compatible storage adapter.
 */
export {
  s3Storage,
  S3CircuitOpenError,
  type AwsCredentialProvider,
  type AwsStaticCredentials,
  type S3CircuitBreakerHealth,
  type S3StorageAdapter,
  type S3StorageConfig,
} from './adapters/s3';

/**
 * Create a local-filesystem storage adapter.
 */
export {
  localStorage,
  LocalCircuitOpenError,
  type LocalCircuitBreakerHealth,
  type LocalStorageAdapter,
  type LocalStorageConfig,
} from './adapters/local';

/**
 * Create an in-memory storage adapter.
 */
export {
  memoryStorage,
  MemoryCircuitOpenError,
  type MemoryCircuitBreakerHealth,
  type MemoryStorageAdapter,
} from './adapters/memory';

/**
 * Resolve a manifest-compatible storage adapter reference.
 */
export { resolveStorageAdapter } from './adapters/index';
/**
 * Typed error classes thrown by image transform operations.
 */
export { ImageTransformError, ImageTransformTimeoutError } from './image/types';

import { ASSETS_PLUGIN_STATE_KEY as CORE_ASSETS_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { PaginatedResult, StorageAdapter } from '@lastshotlabs/slingshot-core';

/** Stable plugin-state key published by `slingshot-assets`. */
export const ASSETS_PLUGIN_STATE_KEY = CORE_ASSETS_PLUGIN_STATE_KEY;

/**
 * Manifest-compatible storage adapter reference.
 *
 * Use this shape in manifest mode to resolve a built-in storage adapter
 * without passing a runtime object instance.
 */
export interface StorageAdapterRef {
  /** Built-in adapter identifier resolved by `resolveStorageAdapter()`. */
  readonly adapter: 's3' | 'local' | 'memory';
  /** Adapter-specific configuration passed to the selected factory. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Presigned URL configuration for asset upload and download operations.
 */
export interface PresignedUrlConfig {
  /** Expiry in seconds for generated presigned URLs. */
  readonly expirySeconds?: number;
}

/**
 * Image optimization configuration for `GET /assets/assets/:id/image`.
 */
export interface ImageConfig {
  /** Allowed source origins for image fetches; relative paths are always allowed. */
  readonly allowedOrigins?: readonly string[];
  /** Maximum output width in pixels. */
  readonly maxWidth?: number;
  /** Maximum output height in pixels. */
  readonly maxHeight?: number;
  /**
   * Hard cap on source bytes loaded into memory before transform.
   * Defends against image-bomb DoS (huge file → OOM). Default: 25 MiB.
   */
  readonly maxInputBytes?: number;
  /**
   * Wall-clock timeout for the Sharp transform pipeline. Defends against
   * malformed inputs that hang decoders. Default: 10 000 ms.
   */
  readonly transformTimeoutMs?: number;
  /** Optional cache adapter used for transformed image responses. */
  readonly cache?: unknown;
}

/**
 * Configuration for `createAssetsPlugin()`.
 */
export interface AssetsPluginConfig {
  /** URL prefix for all asset routes. Defaults to `'/assets'`. */
  readonly mountPath?: string;
  /** Storage adapter instance (code) or manifest-compatible built-in adapter ref. */
  readonly storage: StorageAdapter | StorageAdapterRef;
  /** Maximum allowed file size in bytes. */
  readonly maxFileSize?: number;
  /** Maximum number of files accepted per multipart request. */
  readonly maxFiles?: number;
  /** Allowed MIME type patterns such as `image/*` or `application/pdf`. */
  readonly allowedMimeTypes?: readonly string[];
  /** Prefix prepended to generated storage keys. */
  readonly keyPrefix?: string;
  /** When true, generated storage keys are prefixed with the tenant ID. */
  readonly tenantScopedKeys?: boolean;
  /** Presigned URL behavior for direct upload/download flows. */
  readonly presignedUrls?: boolean | PresignedUrlConfig;
  /** TTL for asset registry records, in seconds. */
  readonly registryTtlSeconds?: number;
  /** Optional image optimization settings. Omit to disable image transforms. */
  readonly image?: ImageConfig;
  /** Tenant identifier used when generating grants or scoped lookups. */
  readonly tenantId?: string;
  /**
   * Number of retry attempts for storage `put()` and `delete()` operations.
   * Each retry waits `attempt × 500 ms` before retrying. Default: 3.
   * Only applies to built-in adapters (e.g. S3); runtime adapter instances
   * are used as-is.
   */
  readonly storageRetryAttempts?: number;
  /**
   * Permit asset deletes to leave behind storage objects when the manifest
   * runtime did not wire a delete-storage middleware. Defaults to `false`.
   *
   * When `false` (default), the plugin refuses to start if any asset entity
   * is declared without a wired delete-cascade — failing fast with the error
   * code `ASSETS_DELETE_MIDDLEWARE_MISSING` so callers don't accidentally
   * orphan blobs in the underlying object store. Set to `true` only as a
   * temporary opt-out (e.g. during a migration where storage cleanup runs
   * asynchronously elsewhere); the plugin will continue to log a warning.
   */
  readonly allowOrphanedStorage?: boolean;
}

/**
 * Asset entity record persisted by the assets plugin.
 */
export interface Asset {
  /** Entity primary key. */
  readonly id: string;
  /** Storage key in the underlying object store. */
  readonly key: string;
  /** Upload owner user ID, when the upload is authenticated. */
  readonly ownerUserId?: string | null;
  /** Tenant scope for the asset, when applicable. */
  readonly tenantId?: string | null;
  /** MIME type recorded for the upload. */
  readonly mimeType?: string | null;
  /** File size in bytes. */
  readonly size?: number | null;
  /** Storage bucket override, when the adapter supports it. */
  readonly bucket?: string | null;
  /** Original filename supplied at upload time. */
  readonly originalName?: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/**
 * Input accepted by `AssetAdapter.create()`.
 */
export interface CreateAssetInput {
  /** Optional explicit entity ID. Defaults to a generated UUID. */
  readonly id?: string;
  /** Storage key in the backing store. */
  readonly key: string;
  /** Upload owner user ID. */
  readonly ownerUserId?: string | null;
  /** Tenant scope for the asset. */
  readonly tenantId?: string | null;
  /** MIME type for the asset. */
  readonly mimeType?: string | null;
  /** File size in bytes. */
  readonly size?: number | null;
  /** Storage bucket override. */
  readonly bucket?: string | null;
  /** Original filename supplied at upload time. */
  readonly originalName?: string | null;
  /** Optional explicit creation timestamp. */
  readonly createdAt?: string;
}

/**
 * Input accepted by `AssetAdapter.update()`.
 */
export interface UpdateAssetInput {
  /** Upload owner user ID. */
  readonly ownerUserId?: string | null;
  /** Tenant scope for the asset. */
  readonly tenantId?: string | null;
  /** MIME type for the asset. */
  readonly mimeType?: string | null;
  /** File size in bytes. */
  readonly size?: number | null;
  /** Storage bucket override. */
  readonly bucket?: string | null;
  /** Original filename supplied at upload time. */
  readonly originalName?: string | null;
}

/**
 * Adapter contract for the `Asset` entity.
 */
export interface AssetAdapter {
  /** Create a new asset record. */
  create(input: CreateAssetInput): Promise<Asset>;
  /** Retrieve a single asset by entity ID. */
  getById(id: string): Promise<Asset | null>;
  /** List asset records with optional entity-layer filters. */
  list(params?: Record<string, unknown>): Promise<PaginatedResult<Asset>>;
  /** Update mutable asset fields. */
  update(id: string, input: UpdateAssetInput): Promise<Asset | null>;
  /** Delete an asset record by entity ID. */
  delete(id: string): Promise<boolean>;
  /** Clear adapter state for isolated tests. */
  clear(): Promise<void>;
  /** List all assets owned by a specific user. */
  listByOwner(params: { ownerUserId: string }): Promise<PaginatedResult<Asset>>;
  /** Return `true` when an asset with the given storage key exists. */
  existsByKey(params: { key: string }): Promise<boolean>;
  /** Find an asset by storage key. */
  findByKey(params: { key: string }): Promise<Asset | null>;
}

/**
 * Runtime state stored in `SlingshotContext.pluginState` under `ASSETS_PLUGIN_STATE_KEY`.
 */
export interface AssetsPluginState {
  /** Resolved asset adapter for the active store backend. */
  readonly assets: AssetAdapter;
  /** Resolved storage adapter used for file bytes. */
  readonly storage: StorageAdapter;
  /** Frozen plugin configuration. */
  readonly config: Readonly<AssetsPluginConfig>;
}

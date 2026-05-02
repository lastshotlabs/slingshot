import { ASSETS_PLUGIN_STATE_KEY as CORE_ASSETS_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { PaginatedResult, StorageAdapter } from '@lastshotlabs/slingshot-core';

/** Stable plugin-state key published by `slingshot-assets`. */
export const ASSETS_PLUGIN_STATE_KEY = CORE_ASSETS_PLUGIN_STATE_KEY;

/**
 * Manifest-compatible storage adapter reference.
 *
 * Use this shape in config-driven mode to resolve a built-in storage adapter
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
  /**
   * Maximum entries before LRU eviction for the built-in in-memory image
   * cache. Default 500. Ignored when a custom `cache` adapter is supplied.
   */
  readonly cacheMaxEntries?: number;
  /**
   * Per-entry TTL in ms for the built-in in-memory image cache. Default
   * 3 600 000 (1 hour). Set to `0` to disable TTL eviction. Ignored when a
   * custom `cache` adapter is supplied.
   */
  readonly cacheTtlMs?: number;
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
   * S3 circuit breaker — number of consecutive operation failures (after
   * retries) before the breaker opens and short-circuits subsequent calls
   * with `S3CircuitOpenError`. Default: 5. Only applies to the built-in S3
   * adapter; runtime adapter instances are used as-is.
   */
  readonly storageCircuitBreakerThreshold?: number;
  /**
   * S3 circuit breaker — cooldown duration in ms before allowing a half-open
   * probe after the breaker opens. Default: 30 000 ms. Only applies to the
   * built-in S3 adapter; runtime adapter instances are used as-is.
   */
  readonly storageCircuitBreakerCooldownMs?: number;
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

  /**
   * Optional callback invoked synchronously when the delete-cascade middleware
   * exhausts its retry budget and the storage object is orphaned. Use this to
   * push the orphaned key onto a recovery queue / outbox table.
   *
   * The callback runs after the failure is logged and the
   * `asset:storageDeleteFailed` event is emitted. Errors thrown by the
   * callback are caught and logged — the orphan recording path is never
   * aborted.
   */
  readonly onOrphanedKey?: (record: OrphanedKeyRecord) => void;

  /**
   * Hard upper bound (in seconds) on a presigned PUT URL TTL. Defaults to
   * `7 * 24 * 3600` (7 days). When the configured/asked-for `expirySeconds`
   * exceeds this cap, `presignUpload` throws a 400 instead of issuing a URL
   * that can outlive the asset record (P-ASSETS-6).
   */
  readonly presignedUploadMaxTtlSeconds?: number;

  /**
   * Optional default for asset-record retention used when validating presign
   * PUT URL TTL (P-ASSETS-6). Falls back to `registryTtlSeconds`. The presign
   * TTL is rejected when it exceeds the smaller of this value and
   * `presignedUploadMaxTtlSeconds`.
   */
  readonly presignedUploadAssetRetentionSeconds?: number;

  /**
   * Optional bypass hook for `presignDownload`. When the calling actor is not
   * the asset's `ownerUserId`, the runtime delegates to this callback. Return
   * `true` to permit the download (e.g. when the caller has a `support` role
   * or the actor kind is `service-account`). The default — when unset — is
   * to deny non-owner downloads with 403.
   *
   * The callback receives the asset record plus a small actor projection
   * (id/kind/tenantId). The plugin does not read `actor.roles` directly
   * because config-driven handlers only see flattened param fields. Apps
   * needing fine-grained role checks resolve their permission service inside
   * the callback.
   */
  readonly presignDownloadAuthorize?: (input: {
    asset: Asset;
    actor: { id: string; kind: string; tenantId: string | null };
  }) => boolean | Promise<boolean>;
}

/**
 * Record passed to {@link AssetsPluginConfig.onOrphanedKey} and surfaced via
 * the `listOrphanedKeys()` recovery API.
 */
export interface OrphanedKeyRecord {
  /** Storage key of the orphaned object. */
  readonly key: string;
  /** Asset entity id, when the asset record was loaded before the failure. */
  readonly assetId: string | null;
  /** Tenant scope of the asset, when known. */
  readonly tenantId: string | null;
  /** Number of failed delete attempts. */
  readonly retries: number;
  /** Last error message returned by the storage adapter. */
  readonly lastError: string;
  /** Wall-clock millisecond timestamp when the failure was recorded. */
  readonly recordedAt: number;
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

/**
 * Domain-specific details for the assets plugin health snapshot.
 */
export interface AssetsHealthDetails {
  /** Storage adapter kind in use (`'s3'`, `'local'`, `'memory'`, or `'custom'` for runtime instances). */
  readonly storageAdapter: 's3' | 'local' | 'memory' | 'custom';
  /** Whether the storage configuration is present and parseable. */
  readonly storageConfigured: boolean;
  /**
   * S3 circuit breaker snapshot — present only when the resolved adapter is
   * an S3 storage adapter that exposes `getCircuitBreakerHealth()`.
   */
  readonly storageCircuitBreaker?: {
    readonly state: 'closed' | 'open' | 'half-open';
    readonly consecutiveFailures: number;
    readonly openedAt: number | undefined;
    readonly nextProbeAt: number | undefined;
  };
  /** Image cache snapshot — present only when image transforms are enabled. */
  readonly imageCache?: {
    /** Current cached entry count. */
    readonly size: number;
    /** Cumulative LRU evictions since cache creation. */
    readonly evictionCount: number;
    /**
     * Cumulative TTL-based evictions since cache creation. Omitted for caches
     * that do not implement TTL eviction.
     */
    readonly ttlEvictionCount?: number;
  };
}

/**
 * Aggregated health snapshot for the assets plugin.
 *
 * Returned by the `getHealth()` method attached to the plugin instance.
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when the storage circuit breaker is `open` or storage is
 *     misconfigured.
 *   - `'degraded'` when the storage circuit breaker is `half-open`.
 *   - `'healthy'` otherwise.
 */
export interface AssetsHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: AssetsHealthDetails;
}

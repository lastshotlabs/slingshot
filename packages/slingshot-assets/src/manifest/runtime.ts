import { HTTPException } from 'hono/http-exception';
import type { Logger, SlingshotEvents, StorageAdapter } from '@lastshotlabs/slingshot-core';
import { noopLogger } from '@lastshotlabs/slingshot-core';
import type { EntityManifestRuntime } from '@lastshotlabs/slingshot-entity';
import {
  createEntityAdapterTransformRegistry,
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { DEFAULT_ASSET_REGISTRY_TTL_SECONDS, withAssetTtl } from '../entities/factories';
import { createServeImageResponse } from '../image/serve';
import type { ResolvedImageConfig } from '../image/serve';
import type { ImageCacheAdapter } from '../image/types';
import { generateUploadKeyFromFilename } from '../lib/upload';
import {
  type OrphanedKeyRegistry,
  createDeleteStorageFileMiddleware,
} from '../middleware/deleteStorageFile';
import type { AssetAdapter, AssetsPluginConfig } from '../types';

/**
 * MIME types refused at presign time AND forced to a generic content type at
 * download time. Browsers must never sniff these as executables / scripts.
 */
export const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/x-executable',
  'application/x-sh',
  'application/x-msdownload',
  'text/html',
  'application/x-httpd-php',
  'application/javascript',
  'text/javascript',
]);

const DEFAULT_PRESIGN_UPLOAD_MAX_TTL_SECONDS = 7 * 24 * 3600;

/** Per-user idempotency cache entry for `presignUpload`. */
interface PresignUploadIdempotencyEntry {
  readonly url: string;
  readonly key: string;
  readonly assetId: string;
  /** Wall-clock millisecond timestamp when this entry expires. */
  readonly expiresAt: number;
  /** In-flight promise so concurrent calls with the same key share the result. */
  readonly inFlight?: Promise<{ url: string; key: string; assetId: string }>;
}

function mimeMatches(mimeType: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }
  return mimeType === pattern;
}

function readRequiredString(params: Record<string, unknown>, key: string, message: string): string {
  const value = params[key];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new HTTPException(400, { message });
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPresignedExpiry(
  config: Readonly<AssetsPluginConfig>,
  params: Record<string, unknown>,
): number {
  const configuredExpiry =
    typeof config.presignedUrls === 'object' ? config.presignedUrls.expirySeconds : undefined;
  const requestedExpiry = readOptionalNumber(params, 'expirySeconds');
  const expiry = requestedExpiry ?? configuredExpiry ?? 3600;
  if (expiry <= 0) {
    throw new HTTPException(400, { message: 'expirySeconds must be positive' });
  }
  return expiry;
}

/**
 * Cap a presigned PUT URL's TTL by the smaller of the configured app-wide
 * ceiling and the asset retention window (P-ASSETS-6). The presign URL must
 * never outlive the asset record itself — otherwise a long-lived URL would
 * still be valid against an evicted/expired asset, which is both confusing
 * for clients and a leakage surface.
 *
 * Throws a 400 with a structured message rather than silently shortening so
 * the caller knows which bound was breached.
 */
function validatePresignUploadTtl(config: Readonly<AssetsPluginConfig>, expiry: number): void {
  const cap = config.presignedUploadMaxTtlSeconds ?? DEFAULT_PRESIGN_UPLOAD_MAX_TTL_SECONDS;
  if (expiry > cap) {
    throw new HTTPException(400, {
      message: `expirySeconds=${expiry} exceeds presignedUploadMaxTtlSeconds=${cap}`,
    });
  }
  const retention =
    config.presignedUploadAssetRetentionSeconds ?? config.registryTtlSeconds ?? null;
  if (retention != null && expiry > retention) {
    throw new HTTPException(400, {
      message: `expirySeconds=${expiry} exceeds asset retention window=${retention}`,
    });
  }
}

function assertPresignedUrlsEnabled<K extends 'presignPut' | 'presignGet'>(
  config: Readonly<AssetsPluginConfig>,
  adapter: StorageAdapter,
  capability: K,
): asserts adapter is StorageAdapter & Required<Pick<StorageAdapter, K>> {
  if (config.presignedUrls === false) {
    throw new HTTPException(501, { message: 'Presigned URLs are disabled for slingshot-assets' });
  }
  if (typeof adapter[capability] !== 'function') {
    throw new HTTPException(501, {
      message: 'Presigned URLs are not supported by the configured storage adapter',
    });
  }
}

function isAssetAdapter(value: BareEntityAdapter): value is BareEntityAdapter & AssetAdapter {
  return (
    typeof value.clear === 'function' &&
    typeof value.listByOwner === 'function' &&
    typeof value.existsByKey === 'function' &&
    typeof value.findByKey === 'function'
  );
}

function requireAssetAdapter(value: BareEntityAdapter, message: string): AssetAdapter {
  if (!isAssetAdapter(value)) {
    throw new Error(message);
  }
  return value;
}

/**
 * Build the manifest runtime for `assetManifest`.
 *
 * @param config - Frozen plugin config.
 * @param storage - Resolved storage adapter for file bytes.
 * @param imageCache - Optional image-cache adapter.
 * @param imageConfig - Optional resolved image config.
 * @param setDeleteStorageMiddleware - Setter used to populate the delete middleware before routes mount.
 * @param setAssetAdapter - Setter used to capture the resolved asset adapter.
 * @param logger - Optional structured logger. Defaults to no-op.
 * @param events - Optional registry-backed event publisher used for emitting `asset:storageDeleteFailed`.
 * @param orphanRegistry - Optional bounded registry that captures orphaned-key records for the recovery API.
 * @returns Runtime registries passed to `createEntityPlugin({ manifestRuntime })`.
 */
export function createAssetsManifestRuntime(args: {
  config: Readonly<AssetsPluginConfig>;
  storage: StorageAdapter;
  imageCache: ImageCacheAdapter | null;
  imageConfig: ResolvedImageConfig | null;
  setDeleteStorageMiddleware: (handler: import('hono').MiddlewareHandler) => void;
  setAssetAdapter: (adapter: AssetAdapter) => void;
  logger?: Logger;
  events?: SlingshotEvents;
  orphanRegistry?: OrphanedKeyRegistry;
  getEvents?: () => SlingshotEvents | undefined;
}): EntityManifestRuntime {
  const {
    config,
    storage,
    imageCache,
    imageConfig,
    setDeleteStorageMiddleware,
    setAssetAdapter,
    orphanRegistry,
    getEvents,
  } = args;
  const logger = args.logger ?? noopLogger;
  const customHandlers = createEntityHandlerRegistry();
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const hooks = createEntityPluginHookRegistry();
  let assetAdapterRef: AssetAdapter | undefined;
  // P-ASSETS-7: per-(user, idempotencyKey) cache of in-flight + recently
  // completed presignUpload requests so concurrent retries with the same
  // logical file don't generate distinct keys/records. Bounded by removing
  // expired entries on every read.
  const presignUploadIdempotencyCache = new Map<string, PresignUploadIdempotencyEntry>();
  const PRESIGN_IDEMPOTENCY_RETENTION_MS = 5 * 60_000;

  function purgePresignIdempotency(): void {
    const now = Date.now();
    for (const [k, entry] of presignUploadIdempotencyCache) {
      if (entry.expiresAt < now && !entry.inFlight) {
        presignUploadIdempotencyCache.delete(k);
      }
    }
  }

  adapterTransforms.register('assets.asset.ttl', adapter => {
    const assetAdapter = requireAssetAdapter(
      adapter,
      '[slingshot-assets] Asset adapter does not expose the full assets runtime contract',
    );
    const transformed: BareEntityAdapter = {
      ...withAssetTtl(
        assetAdapter,
        config.registryTtlSeconds ?? DEFAULT_ASSET_REGISTRY_TTL_SECONDS,
      ),
    };
    return Promise.resolve(transformed);
  });

  hooks.register('assets.captureAssetAdapter', ({ adapters }) => {
    const assetAdapter = requireAssetAdapter(
      adapters.Asset,
      '[slingshot-assets] Manifest resolved Asset adapter is missing required asset operations',
    );
    assetAdapterRef = assetAdapter;
    setAssetAdapter(assetAdapter);
    setDeleteStorageMiddleware(
      createDeleteStorageFileMiddleware({
        storage,
        assetAdapter,
        logger,
        // Resolve events lazily — at hook time the host plugin may have a
        // captured publisher that wasn't yet available when the runtime was
        // built (manifest-mode setup ordering).
        events: args.events ?? getEvents?.(),
        orphanRegistry,
        ...(config.onOrphanedKey ? { onOrphanedKey: config.onOrphanedKey } : {}),
      }),
    );
  });

  customHandlers.register('assets.asset.presignUpload', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    assertPresignedUrlsEnabled(config, storage, 'presignPut');
    const assetAdapter = assetAdapterRef;
    if (!assetAdapter) {
      throw new Error(
        '[slingshot-assets] Asset adapter is not ready during manifest handler setup',
      );
    }

    const userId = readRequiredString(params, 'actor.id', 'Authenticated user required');
    const filename = readOptionalString(params, 'filename');
    const mimeType = readOptionalString(params, 'mimeType');
    const tenantId = readOptionalString(params, 'tenantId') ?? config.tenantId;
    const idempotencyKey = readOptionalString(params, 'idempotencyKey');
    const expirySeconds = readPresignedExpiry(config, params);
    // P-ASSETS-6: presigned PUT URL TTL must not outlive the asset record.
    validatePresignUploadTtl(config, expirySeconds);

    if (mimeType && BLOCKED_MIME_TYPES.has(mimeType)) {
      throw new HTTPException(400, { message: 'File type not allowed.' });
    }

    const allowedMimeTypes = config.allowedMimeTypes;
    if (allowedMimeTypes && allowedMimeTypes.length > 0) {
      if (!mimeType) {
        throw new HTTPException(400, {
          message: 'mimeType is required when allowedMimeTypes is configured.',
        });
      }
      const allowed = allowedMimeTypes.some(pattern => mimeMatches(mimeType, pattern));
      if (!allowed) {
        throw new HTTPException(400, { message: `File type "${mimeType}" not allowed.` });
      }
    }

    // P-ASSETS-7: idempotency key path. Concurrent (or retried) calls with
    // the same (userId, idempotencyKey) tuple must return the SAME record /
    // URL — we never want a second `assets.create()` against a logically-
    // identical request. We support two cases:
    //   1. A concurrent in-flight request — share its promise.
    //   2. A recently-completed request still inside the retention window —
    //      return the cached record directly.
    // Apps that want stronger guarantees (idempotency across processes) can
    // prefix the key with their own request id and use a durable backend.
    const cacheKey = idempotencyKey ? `${userId}:${idempotencyKey}` : null;
    if (cacheKey) {
      purgePresignIdempotency();
      const existing = presignUploadIdempotencyCache.get(cacheKey);
      if (existing?.inFlight) return existing.inFlight;
      if (existing && existing.expiresAt >= Date.now()) {
        return { url: existing.url, key: existing.key, assetId: existing.assetId };
      }
    }

    const performPresign = async (): Promise<{
      url: string;
      key: string;
      assetId: string;
    }> => {
      const key = generateUploadKeyFromFilename(
        filename,
        { userId, tenantId },
        {
          keyPrefix: config.keyPrefix,
          tenantScopedKeys: config.tenantScopedKeys,
        },
      );

      const url = await storage.presignPut(key, {
        expirySeconds,
        mimeType,
        maxSize: config.maxFileSize,
      });
      const asset = await assetAdapter.create({
        key,
        ownerUserId: userId,
        tenantId: tenantId ?? null,
        mimeType: mimeType ?? null,
        size: null,
        bucket: null,
        originalName: filename ?? null,
      });

      return { url, key, assetId: asset.id };
    };

    if (!cacheKey) return performPresign();

    const inFlight = performPresign();
    presignUploadIdempotencyCache.set(cacheKey, {
      url: '',
      key: '',
      assetId: '',
      expiresAt: Date.now() + PRESIGN_IDEMPOTENCY_RETENTION_MS,
      inFlight,
    });
    try {
      const result = await inFlight;
      presignUploadIdempotencyCache.set(cacheKey, {
        url: result.url,
        key: result.key,
        assetId: result.assetId,
        expiresAt: Date.now() + PRESIGN_IDEMPOTENCY_RETENTION_MS,
      });
      return result;
    } catch (err) {
      // Failed presigns are not cached — the caller can retry without
      // poisoning the slot.
      presignUploadIdempotencyCache.delete(cacheKey);
      throw err;
    }
  });

  customHandlers.register('assets.asset.presignDownload', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    assertPresignedUrlsEnabled(config, storage, 'presignGet');
    const assetAdapter = assetAdapterRef;
    if (!assetAdapter) {
      throw new Error(
        '[slingshot-assets] Asset adapter is not ready during manifest handler setup',
      );
    }

    const key = readRequiredString(params, 'key', 'key is required');
    const userId = readRequiredString(params, 'actor.id', 'Authenticated user required');
    const actorKind = readOptionalString(params, 'actor.kind') ?? 'user';
    const tenantId = readOptionalString(params, 'tenantId');
    const expirySeconds = readPresignedExpiry(config, params);

    const asset = await assetAdapter.findByKey({ key });
    if (!asset) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    if (asset.tenantId && tenantId && asset.tenantId !== tenantId) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }

    // P-ASSETS-9: ownership / creator binding. Default behavior: actor.id
    // must match asset.ownerUserId. Apps that need bypass (admin, support
    // tools, batch processors) wire `presignDownloadAuthorize` to allow it.
    const isOwner = asset.ownerUserId != null && asset.ownerUserId === userId;
    let authorized = isOwner;
    if (!authorized && config.presignDownloadAuthorize) {
      try {
        authorized = await Promise.resolve(
          config.presignDownloadAuthorize({
            asset,
            actor: { id: userId, kind: actorKind, tenantId: tenantId ?? null },
          }),
        );
      } catch (err) {
        logger.warn('presignDownloadAuthorize callback threw', {
          component: 'slingshot-assets.runtime',
          err: err instanceof Error ? err.message : String(err),
        });
        authorized = false;
      }
    }
    if (!authorized) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }

    // P-ASSETS-10: refuse to issue presigned URLs for assets whose stored
    // mimeType is in the blocklist. The bucket can't enforce response-side
    // safety headers from Slingshot, so the safest action is to refuse the
    // download outright. Apps with legitimate use cases for those MIME types
    // must configure their bucket to override the response content-type.
    const storedMime = asset.mimeType ?? null;
    if (storedMime && BLOCKED_MIME_TYPES.has(storedMime)) {
      throw new HTTPException(415, {
        message: `Refusing to presign download for blocked MIME type "${storedMime}".`,
      });
    }

    const url = await storage.presignGet(key, { expirySeconds });
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    // Surface the safe response-header recommendation in the JSON payload so
    // operators using a custom edge / proxy can apply it to the download
    // response. Always include `nosniff`; for blocked-but-unenforceable MIMEs
    // (above we already throw, so this branch is defensive) advise the
    // attachment disposition.
    return {
      url,
      expiresAt,
      responseHeaders: {
        'X-Content-Type-Options': 'nosniff',
        ...(storedMime && BLOCKED_MIME_TYPES.has(storedMime)
          ? {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment',
            }
          : {}),
      },
    };
  });

  customHandlers.register('assets.asset.serveImage', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const assetAdapter = assetAdapterRef;
    if (!assetAdapter) {
      throw new Error(
        '[slingshot-assets] Asset adapter is not ready during manifest handler setup',
      );
    }
    if (!imageConfig || !imageCache) {
      throw new HTTPException(501, { message: 'Image transforms are not enabled' });
    }

    const id = readRequiredString(params, 'id', 'id is required');
    const userId = readRequiredString(params, 'actor.id', 'Authenticated user required');
    const tenantId = readOptionalString(params, 'tenantId');
    const asset = await assetAdapter.getById(id);
    if (!asset) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    if (asset.tenantId && asset.tenantId !== tenantId) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }
    if (!asset.ownerUserId || asset.ownerUserId !== userId) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }

    return createServeImageResponse({
      asset,
      storage,
      cache: imageCache,
      imageConfig,
      params: {
        id,
        w: params.w,
        h: params.h,
        f: params.f,
        q: params.q,
      },
    });
  });

  return {
    customHandlers,
    adapterTransforms,
    hooks,
  };
}

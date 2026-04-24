import { HTTPException } from 'hono/http-exception';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
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
import { createDeleteStorageFileMiddleware } from '../middleware/deleteStorageFile';
import type { AssetAdapter, AssetsPluginConfig } from '../types';

const BLOCKED_MIME_TYPES = new Set([
  'application/x-executable',
  'application/x-sh',
  'application/x-msdownload',
  'text/html',
  'application/x-httpd-php',
  'application/javascript',
  'text/javascript',
]);

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
 * @returns Runtime registries passed to `createEntityPlugin({ manifestRuntime })`.
 */
export function createAssetsManifestRuntime(args: {
  config: Readonly<AssetsPluginConfig>;
  storage: StorageAdapter;
  imageCache: ImageCacheAdapter | null;
  imageConfig: ResolvedImageConfig | null;
  setDeleteStorageMiddleware: (handler: import('hono').MiddlewareHandler) => void;
  setAssetAdapter: (adapter: AssetAdapter) => void;
}): EntityManifestRuntime {
  const { config, storage, imageCache, imageConfig, setDeleteStorageMiddleware, setAssetAdapter } =
    args;
  const customHandlers = createEntityHandlerRegistry();
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const hooks = createEntityPluginHookRegistry();
  let assetAdapterRef: AssetAdapter | undefined;

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
    const expirySeconds = readPresignedExpiry(config, params);

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
    const tenantId = readOptionalString(params, 'tenantId');
    const expirySeconds = readPresignedExpiry(config, params);

    const asset = await assetAdapter.findByKey({ key });
    if (!asset) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    if (asset.tenantId && tenantId && asset.tenantId !== tenantId) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }
    if (!asset.ownerUserId || asset.ownerUserId !== userId) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }

    const url = await storage.presignGet(key, { expirySeconds });
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    return { url, expiresAt };
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

import { extname } from 'node:path';
import type { Context } from 'hono';
import type { AppEnv, StorageAdapter, UploadResult } from '@lastshotlabs/slingshot-core';
import { HttpError, getActorId, getActorTenantId, resolveContext } from '@lastshotlabs/slingshot-core';

/**
 * Options for multipart and direct upload helpers.
 */
export interface UploadOpts {
  /** Multipart field name or names to inspect. Defaults to `['file']`. */
  field?: string | string[];
  /** Maximum accepted file size in bytes. Defaults to 10 MB. */
  maxFileSize?: number;
  /** Maximum number of accepted files. Defaults to 10. */
  maxFiles?: number;
  /** MIME type allow-list patterns such as `image/*`. */
  allowedMimeTypes?: string[];
  /** Prefix prepended to generated object keys. */
  keyPrefix?: string;
  /** Custom key generator override. */
  generateKey?: (file: File, ctx: { userId?: string; tenantId?: string }) => string;
  /** When true, prepend `tenantId/` to generated keys when a tenant exists. */
  tenantScopedKeys?: boolean;
}

type UploadCarrier = object;

function getUploadState(input: UploadCarrier): {
  adapter: StorageAdapter | null;
  config: UploadOpts;
} {
  const ctx = resolveContext(input);
  const state = ctx.upload;
  if (!state) return { adapter: null, config: {} };
  return {
    adapter: (state.adapter as StorageAdapter | null) ?? null,
    config: { ...(state.config as UploadOpts) },
  };
}

function mergeUploadConfig(input: UploadCarrier | undefined, opts?: UploadOpts): UploadOpts {
  const base = input ? getUploadConfig(input) : {};
  return { ...base, ...opts };
}

function mimeMatches(mimeType: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }
  return mimeType === pattern;
}

/**
 * Read the resolved storage adapter from Slingshot runtime state.
 *
 * @param input - App or request-scoped carrier passed through `resolveContext()`.
 * @returns The configured storage adapter, or `null` when uploads are disabled.
 */
export function getStorageAdapter(input: UploadCarrier): StorageAdapter | null {
  return getUploadState(input).adapter;
}

/**
 * Read the resolved upload configuration from Slingshot runtime state.
 *
 * @param input - App or request-scoped carrier passed through `resolveContext()`.
 * @returns A shallow copy of the effective upload configuration.
 */
export function getUploadConfig(input: UploadCarrier): UploadOpts {
  return getUploadState(input).config;
}

/**
 * Generate a storage key for an uploaded file.
 *
 * @param file - Uploaded file metadata.
 * @param ctx - Auth and tenancy context used for optional key scoping.
 * @param opts - Per-call overrides.
 * @param input - Optional app or request carrier providing default upload config.
 * @returns A UUID-based storage key that preserves a safe filename extension.
 */
export function generateUploadKey(
  file: File,
  ctx: { userId?: string; tenantId?: string },
  opts?: UploadOpts,
  input?: UploadCarrier,
): string {
  const merged = mergeUploadConfig(input, opts);
  if (merged.generateKey) return merged.generateKey(file, ctx);
  const rawExt = extname(file.name);
  const ext = /^\.[a-zA-Z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const uuid = crypto.randomUUID();
  const prefix = merged.keyPrefix ?? 'uploads/';
  const tenantPrefix = merged.tenantScopedKeys && ctx.tenantId ? `${ctx.tenantId}/` : '';
  return `${prefix}${tenantPrefix}${uuid}${ext}`;
}

/**
 * Generate a storage key from a filename without requiring a `File` instance.
 *
 * @param filename - Original filename, when available.
 * @param ctx - Auth and tenancy context used for optional key scoping.
 * @param opts - Per-call overrides.
 * @param input - Optional app or request carrier providing default upload config.
 * @returns A UUID-based storage key that preserves a safe filename extension.
 */
export function generateUploadKeyFromFilename(
  filename: string | undefined,
  ctx: { userId?: string; tenantId?: string },
  opts?: UploadOpts,
  input?: UploadCarrier,
): string {
  const merged = mergeUploadConfig(input, opts);
  if (merged.generateKey) {
    const stub = new File([], filename ?? 'upload');
    return merged.generateKey(stub, ctx);
  }
  const rawExt = filename ? extname(filename) : '';
  const ext = /^\.[a-zA-Z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const uuid = crypto.randomUUID();
  const prefix = merged.keyPrefix ?? 'uploads/';
  const tenantPrefix = merged.tenantScopedKeys && ctx.tenantId ? `${ctx.tenantId}/` : '';
  return `${prefix}${tenantPrefix}${uuid}${ext}`;
}

/**
 * Validate a file against size and MIME policy.
 *
 * @param file - File to validate.
 * @param opts - Validation overrides.
 * @param input - Optional app or request carrier providing default upload config.
 * @returns An error message when invalid, otherwise `null`.
 */
export function validateFile(
  file: File,
  opts: { maxFileSize?: number; allowedMimeTypes?: string[] },
  input?: UploadCarrier,
): string | null {
  const merged = mergeUploadConfig(input, opts);
  const maxFileSize = merged.maxFileSize ?? 10 * 1024 * 1024;
  if (file.size > maxFileSize) {
    return `File "${file.name}" exceeds maximum size of ${maxFileSize} bytes`;
  }
  const allowedMimeTypes = merged.allowedMimeTypes;
  if (allowedMimeTypes && allowedMimeTypes.length > 0) {
    const allowed = allowedMimeTypes.some(pattern => mimeMatches(file.type, pattern));
    if (!allowed) {
      return `File "${file.name}" has disallowed MIME type "${file.type}"`;
    }
  }
  return null;
}

/**
 * Upload a single file through the resolved storage adapter.
 *
 * This helper stores bytes only; callers that also persist asset metadata should
 * create the entity record separately after upload succeeds.
 *
 * @param file - File to upload.
 * @param opts - Upload configuration and contextual metadata.
 * @returns Upload metadata for downstream handlers.
 * @throws {HttpError} When no adapter is configured or validation fails.
 */
export async function processUpload(
  file: File,
  opts: UploadOpts & {
    ctx?: { userId?: string; tenantId?: string };
    bucket?: string;
    carrier?: object;
  },
): Promise<UploadResult> {
  const carrier = opts.carrier;
  const adapter = carrier ? getStorageAdapter(carrier) : null;
  if (!adapter) throw new HttpError(500, 'No storage adapter configured');

  const validationError = validateFile(file, opts, carrier);
  if (validationError) throw new HttpError(400, validationError);

  const key = generateUploadKey(file, opts.ctx ?? {}, opts, carrier);
  const { url } = await adapter.put(key, file, {
    mimeType: file.type,
    size: file.size,
    bucket: opts.bucket,
  });

  return {
    key,
    originalName: file.name,
    mimeType: file.type,
    size: file.size,
    ...(url !== undefined ? { url } : {}),
  };
}

/**
 * Parse multipart uploads from the current request and upload each discovered file.
 *
 * Parsed results are returned in request order across the configured form fields.
 *
 * @param c - Hono request context.
 * @param opts - Optional per-route upload overrides.
 * @returns Uploaded file metadata for all discovered files.
 */
export async function parseUpload(c: Context<AppEnv>, opts?: UploadOpts): Promise<UploadResult[]> {
  const slingshotCtx = c.get('slingshotCtx');
  const merged = mergeUploadConfig(slingshotCtx, opts);
  const fields = merged.field
    ? Array.isArray(merged.field)
      ? merged.field
      : [merged.field]
    : ['file'];
  const maxFiles = merged.maxFiles ?? 10;

  const body = await c.req.parseBody({ all: true });
  const results: UploadResult[] = [];

  const userId = getActorId(c) ?? undefined;
  const tenantId = getActorTenantId(c) ?? undefined;
  const bucket = c.get('uploadBucket');

  for (const field of fields) {
    const raw = body[field];
    if (!raw) continue;
    const files = Array.isArray(raw) ? raw : [raw];
    for (const candidate of files) {
      if (!(candidate instanceof File)) continue;
      if (results.length >= maxFiles) {
        throw new HttpError(400, `Too many files. Maximum is ${maxFiles}`);
      }
      const result = await processUpload(candidate, {
        ...merged,
        ctx: { userId, tenantId },
        bucket: bucket ?? undefined,
        carrier: slingshotCtx,
      });
      results.push(result);
    }
  }

  return results;
}

import { extname } from 'node:path';
import type { Context } from 'hono';
import type { StorageAdapter, UploadResult } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, resolveContext } from '@lastshotlabs/slingshot-core';

export interface UploadOpts {
  field?: string | string[];
  maxFileSize?: number;
  maxFiles?: number;
  allowedMimeTypes?: string[];
  keyPrefix?: string;
  generateKey?: (file: File, ctx: { userId?: string; tenantId?: string }) => string;
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

export const getStorageAdapter = (input: UploadCarrier): StorageAdapter | null =>
  getUploadState(input).adapter;

export const getUploadConfig = (input: UploadCarrier): UploadOpts => getUploadState(input).config;

function mergeUploadConfig(input: UploadCarrier | undefined, opts?: UploadOpts): UploadOpts {
  const base = input ? getUploadConfig(input) : {};
  return { ...base, ...opts };
}

export const generateUploadKey = (
  file: File,
  ctx: { userId?: string; tenantId?: string },
  opts?: UploadOpts,
  input?: UploadCarrier,
): string => {
  const merged = mergeUploadConfig(input, opts);
  if (merged.generateKey) return merged.generateKey(file, ctx);
  const rawExt = extname(file.name);
  const ext = /^\.[a-zA-Z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const uuid = crypto.randomUUID();
  const prefix = merged.keyPrefix ?? 'uploads/';
  const tenantPrefix = merged.tenantScopedKeys && ctx.tenantId ? `${ctx.tenantId}/` : '';
  return `${prefix}${tenantPrefix}${uuid}${ext}`;
};

export const generateUploadKeyFromFilename = (
  filename: string | undefined,
  ctx: { userId?: string; tenantId?: string },
  opts?: UploadOpts,
  input?: UploadCarrier,
): string => {
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
};

const mimeMatches = (mimeType: string, pattern: string): boolean => {
  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }
  return mimeType === pattern;
};

export const validateFile = (
  file: File,
  opts: { maxFileSize?: number; allowedMimeTypes?: string[] },
  input?: UploadCarrier,
): string | null => {
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
};

export const processUpload = async (
  file: File,
  opts: UploadOpts & {
    ctx?: { userId?: string; tenantId?: string };
    bucket?: string;
    carrier?: object;
  },
): Promise<UploadResult> => {
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

  if (carrier) {
    const { registerUpload } = await import('@framework/upload/registry');
    await registerUpload(
      {
        key,
        ownerUserId: opts.ctx?.userId,
        tenantId: opts.ctx?.tenantId,
        mimeType: file.type,
        bucket: opts.bucket,
        createdAt: Date.now(),
      },
      carrier,
    );
  }

  return {
    key,
    originalName: file.name,
    mimeType: file.type,
    size: file.size,
    ...(url !== undefined ? { url } : {}),
  };
};

export const parseUpload = async (
  c: Context<AppEnv>,
  opts?: UploadOpts,
): Promise<UploadResult[]> => {
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

  const userId = c.get('authUserId') ?? undefined;
  const tenantId = c.get('tenantId') ?? undefined;
  const bucket = c.get('uploadBucket');

  for (const field of fields) {
    const raw = body[field];
    if (!raw) continue;
    const files = Array.isArray(raw) ? raw : [raw];
    for (const f of files) {
      if (!(f instanceof File)) continue;
      if (results.length >= maxFiles) {
        throw new HttpError(400, `Too many files. Maximum is ${maxFiles}`);
      }
      const result = await processUpload(f, {
        ...merged,
        ctx: { userId, tenantId },
        bucket: bucket ?? undefined,
        carrier: slingshotCtx,
      });
      results.push(result);
    }
  }

  return results;
};

import { getUploadConfig, parseUpload } from '@framework/upload/upload';
import type { UploadOpts } from '@framework/upload/upload';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Options for the `handleUpload` middleware.
 *
 * All fields are optional overrides of the app-level upload configuration
 * stored in `SlingshotContext`.  Values provided here take precedence over the
 * app-level defaults for a specific route.
 *
 * See `UploadOpts` (from `@framework/upload/upload`) for available fields:
 * `maxFileSize`, `maxFiles`, `allowedMimeTypes`, `keyPrefix`, etc.
 */
export type UploadMiddlewareOptions = UploadOpts;

/**
 * Hono middleware that parses a multipart or form-encoded file upload and stores
 * the parsed results on the request context for the downstream route handler.
 *
 * Performs a fast `Content-Length` pre-check before reading the body to reject
 * obviously oversized requests without buffering them, avoiding Bun's
 * connection-kill behaviour on payload overflow.
 *
 * Parsed results are set on `c.get('uploadResults')`.
 *
 * @param opts - Per-route upload options that override the app-level upload
 *   configuration.  All fields are optional.
 * @returns A Hono `MiddlewareHandler` that parses the incoming upload and
 *   stores the results before calling the next handler.
 * @throws Responds with `400 Bad Request` when the upload is malformed.
 * @throws Responds with `413 Payload Too Large` when the body exceeds
 *   `maxFileSize * maxFiles`.
 *
 * @example
 * ```ts
 * router.post('/avatar', handleUpload({ maxFiles: 1, allowedMimeTypes: ['image/*'] }), async c => {
 *   const [file] = c.get('uploadResults') ?? [];
 *   // process file...
 * });
 * ```
 */
export const handleUpload = (opts?: UploadMiddlewareOptions): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const config = getUploadConfig(c.get('slingshotCtx'));
    const merged = { ...config, ...opts };
    const maxFileSize = merged.maxFileSize ?? 10 * 1024 * 1024;
    const maxFiles = merged.maxFiles ?? 10;

    // Content-Length pre-check to avoid Bun killing the connection
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > 0 && contentLength > maxFileSize * maxFiles) {
      return c.json(
        { error: `Request body too large. Maximum is ${maxFileSize * maxFiles} bytes` },
        413,
      );
    }

    let results;
    try {
      results = await parseUpload(c, opts);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 400) return c.json({ error: e.message }, 400);
      if (e.status === 413) return c.json({ error: e.message }, 413);
      throw err;
    }

    c.set('uploadResults', results);
    await next();
  };
};

import type { PresignedUrlConfig } from '@config/types/upload';
import { getAuthenticatedAccountGuardFailure } from '@framework/lib/authRouteGuard';
import { deleteUploadRecord, getUploadRecord, registerUpload } from '@framework/upload/registry';
import {
  generateUploadKeyFromFilename,
  getStorageAdapter,
  getUploadConfig,
} from '@framework/upload/upload';
import { createPresignedUrl } from '@lib/signing';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createRoute } from '@lastshotlabs/slingshot-core';
import {
  createRouter,
  getActor,
  getRouteAuth,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';

const tags = ['Uploads'];

function mimeMatches(mimeType: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }
  return mimeType === pattern;
}

/**
 * Configuration for the uploads REST router.
 *
 * Extends `PresignedUrlConfig` (base path, expiry settings) with additional
 * access-control options.
 */
interface UploadsRouterConfig extends PresignedUrlConfig {
  /**
   * Authorization hooks for read and delete access to stored files.
   * When omitted, access defaults to owner-only (matched by `ownerUserId` in
   * the upload registry).
   */
  authorization?: {
    /**
     * Called when the requester is not the registered owner of the file, or
     * when `allowExternalKeys` is `true` and the key has no registry record.
     * Return `true` to grant access, `false` to deny.
     */
    authorize?: (input: {
      /** The operation being performed. */
      action: 'read' | 'delete';
      /** The storage key of the file being accessed. */
      key: string;
      /** Authenticated user ID, if available. */
      userId?: string;
      /** Resolved tenant ID, if available. */
      tenantId?: string;
    }) => boolean | Promise<boolean>;
  };
  /**
   * When `true`, files whose keys are not present in the upload registry are
   * still accessible (subject to the `authorization.authorize` callback).
   * When `false` (default), unregistered keys always return `404`.
   */
  allowExternalKeys?: boolean;
}

/**
 * Determine whether the authenticated user is permitted to perform `action` on
 * the file identified by `key`.
 *
 * Access control logic (in order):
 * 1. If a registry record exists and its `tenantId` does not match the
 *    requester's tenant, access is always denied (cross-tenant access prevention).
 * 2. Owner match (`record.ownerUserId === userId`) grants access.
 * 3. No owner or owner mismatch: `config.authorization.authorize` is called.
 * 4. If the key is not in the registry and `config.allowExternalKeys` is `true`,
 *    the `authorize` callback is tried.
 * 5. If the key is not in the registry and `allowExternalKeys` is `false`,
 *    the result is `{ allowed: false, notFound: true }`.
 *
 * @param action - The operation being checked (`"read"` or `"delete"`).
 * @param key - The storage key of the file.
 * @param userId - Authenticated user ID, or `null`/`undefined` if not logged in.
 * @param tenantId - Resolved tenant ID, or `null`/`undefined` if not applicable.
 * @param config - The uploads router config (carries `authorization` and
 *   `allowExternalKeys` settings).
 * @param app - The Hono app instance (used to look up upload registry records).
 * @returns An object with `allowed` (access granted) and `notFound` (key absent
 *   from registry and `allowExternalKeys` is disabled).
 * @throws May throw if the `authorize` callback throws (propagated to caller).
 */
async function checkUploadAccess(
  action: 'read' | 'delete',
  key: string,
  userId: string | null | undefined,
  tenantId: string | null | undefined,
  config: UploadsRouterConfig,
  app: object,
): Promise<{ allowed: boolean; notFound: boolean }> {
  const record = await getUploadRecord(key, app);
  const authorize = config.authorization?.authorize;
  const allowExternalKeys = config.allowExternalKeys ?? false;

  if (record) {
    // If the registry record has a tenantId, the requester must match — period.
    if (record.tenantId && record.tenantId !== tenantId) {
      return { allowed: false, notFound: false };
    }
    // Owner match → allow
    if (record.ownerUserId && record.ownerUserId === userId) {
      return { allowed: true, notFound: false };
    }
    // No owner or owner mismatch → try callback
    if (authorize) {
      const ok = await authorize({
        action,
        key,
        userId: userId ?? undefined,
        tenantId: tenantId ?? undefined,
      });
      return { allowed: ok, notFound: false };
    }
    return { allowed: false, notFound: false };
  }

  // Record not in registry
  if (allowExternalKeys) {
    if (authorize) {
      const ok = await authorize({
        action,
        key,
        userId: userId ?? undefined,
        tenantId: tenantId ?? undefined,
      });
      return { allowed: ok, notFound: false };
    }
    return { allowed: false, notFound: false };
  }

  return { allowed: false, notFound: true };
}

/**
 * Create a Hono router that provides file upload REST endpoints.
 *
 * Mounts the following authenticated routes under `config.path` (default `/uploads`):
 * - `POST /uploads/presign` — generate a presigned PUT URL for direct-to-storage upload.
 * - `GET /uploads/presign/:key` — generate a presigned GET URL for a stored file.
 * - `DELETE /uploads/:key` — delete a stored file and its registry record.
 *
 * All routes require a valid user session (enforced via `userAuth`).  Read and
 * delete operations additionally require ownership of the file (matched via the
 * upload registry) or approval from `config.authorization.authorize`. Route
 * handlers also fail closed with `403` when a stale authenticated session
 * belongs to a suspended account or to an account that no longer satisfies a
 * required email-verification policy.
 *
 * @param config - Uploads router configuration.  See `UploadsRouterConfig` for
 *   all available fields.
 * @returns An OpenAPI-annotated Hono router.
 */
export const createUploadsRouter = (config: UploadsRouterConfig) => {
  const router = createRouter();
  const basePath = (config.path ?? '/uploads').replace(/\/$/, '');

  router.use(`${basePath}/*`, (c: Context<AppEnv, string>, next: Next) =>
    getRouteAuth(getSlingshotCtx(c)).userAuth(c, next),
  );

  /**
   * MIME types that are never accepted for presigned upload URLs.
   *
   * Allowing these types would permit uploading server-executable or
   * browser-executable content (scripts, HTML, PHP) to a storage bucket
   * that may later be served back to users, enabling stored XSS or remote
   * code execution via the storage backend.
   */
  const BLOCKED_MIME_TYPES = new Set([
    'application/x-executable',
    'application/x-sh',
    'application/x-msdownload',
    'text/html',
    'application/x-httpd-php',
    'application/javascript',
    'text/javascript',
  ]);

  const presignRoute = createRoute({
    method: 'post',
    path: `${basePath}/presign`,
    tags,
    summary: 'Generate presigned upload URL',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              filename: z
                .string()
                .optional()
                .describe('Original filename (used to derive the storage key extension)'),
              mimeType: z.string().optional().describe('MIME type of the file'),
              expirySeconds: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('URL expiry in seconds'),
              maxBytes: z
                .number()
                .int()
                .positive()
                .max(100 * 1024 * 1024)
                .optional()
                .describe(
                  'Maximum allowed file size in bytes (client-enforced via Content-Length header). Defaults to 10MB. Maximum: 100MB.',
                ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Presigned URL generated',
        content: {
          'application/json': {
            schema: z.object({ url: z.string(), key: z.string(), maxBytes: z.number().optional() }),
          },
        },
      },
      400: {
        description: 'File type not allowed',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      413: {
        description: 'Requested upload size exceeds the configured limit',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      403: {
        description:
          'Account is suspended or must verify its email before upload access is allowed',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      501: {
        description: 'Not implemented by adapter',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  router.openapi(presignRoute, async c => {
    const slingshotCtx = c.get('slingshotCtx');
    const adapter = getStorageAdapter(slingshotCtx);
    const uploadConfig = getUploadConfig(slingshotCtx);
    const guardFailure = await getAuthenticatedAccountGuardFailure(c);
    if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
    if (!adapter?.presignPut) {
      return c.json(
        { error: 'Presigned URLs not supported by the configured storage adapter' },
        501,
      );
    }
    const { filename, mimeType, expirySeconds, maxBytes } = c.req.valid('json');

    if (mimeType && BLOCKED_MIME_TYPES.has(mimeType)) {
      return c.json({ error: 'File type not allowed.' }, 400);
    }

    const allowedMimeTypes = uploadConfig.allowedMimeTypes;
    if (allowedMimeTypes && allowedMimeTypes.length > 0) {
      if (!mimeType) {
        return c.json(
          { error: 'mimeType is required when upload.allowedMimeTypes is configured.' },
          400,
        );
      }
      const allowed = allowedMimeTypes.some(pattern => mimeMatches(mimeType, pattern));
      if (!allowed) {
        return c.json({ error: `File type "${mimeType}" not allowed.` }, 400);
      }
    }

    const configuredMaxFileSize = uploadConfig.maxFileSize;
    if (
      configuredMaxFileSize !== undefined &&
      maxBytes !== undefined &&
      maxBytes > configuredMaxFileSize
    ) {
      return c.json(
        {
          error: `Requested upload size exceeds configured limit of ${configuredMaxFileSize} bytes.`,
        },
        413,
      );
    }

    const app = slingshotCtx.app;
    const actor = getActor(c);
    const userId = actor.id ?? undefined;
    const tenantId = actor.tenantId ?? undefined;

    // Server-generates the key — client cannot control the storage path
    const key = generateUploadKeyFromFilename(
      filename,
      { userId, tenantId },
      undefined,
      slingshotCtx,
    );

    const expiry =
      expirySeconds ?? (typeof config.expirySeconds === 'number' ? config.expirySeconds : 3600);
    const effectiveMaxBytes =
      maxBytes !== undefined
        ? maxBytes
        : configuredMaxFileSize !== undefined
          ? configuredMaxFileSize
          : undefined;
    const url = await adapter.presignPut(key, {
      expirySeconds: expiry,
      mimeType,
      maxSize: effectiveMaxBytes,
    });

    // Register the upload for ownership tracking
    await registerUpload(
      {
        key,
        ownerUserId: userId,
        tenantId,
        mimeType,
        bucket: c.get('uploadBucket') ?? undefined,
        createdAt: Date.now(),
      },
      app,
    );

    return c.json(
      { url, key, ...(effectiveMaxBytes !== undefined ? { maxBytes: effectiveMaxBytes } : {}) },
      200,
    );
  });

  const presignGetRoute = createRoute({
    method: 'get',
    path: `${basePath}/presign/:key{.+}`,
    tags,
    summary: 'Generate presigned download URL',
    request: {
      params: z.object({ key: z.string() }),
      query: z.object({
        expiry: z.string().optional().describe('URL expiry in seconds (default: 3600)'),
      }),
    },
    responses: {
      200: {
        description: 'Presigned download URL',
        content: {
          'application/json': {
            schema: z.object({
              url: z.string(),
              expiresAt: z.number().describe('Unix timestamp (seconds) when the URL expires'),
            }),
          },
        },
      },
      403: {
        description: 'Forbidden — not the owner or unauthorized',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      404: {
        description: 'Key not found in upload registry',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      501: {
        description: 'Not implemented',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  router.openapi(presignGetRoute, async c => {
    const { key } = c.req.valid('param');
    const { expiry: expiryStr } = c.req.valid('query');
    const guardFailure = await getAuthenticatedAccountGuardFailure(c);
    if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
    const actor = getActor(c);
    const userId = actor.id;
    const tenantId = actor.tenantId;
    const app = c.get('slingshotCtx').app;

    const { allowed, notFound } = await checkUploadAccess(
      'read',
      key,
      userId,
      tenantId,
      config,
      app,
    );
    if (notFound) return c.json({ error: 'Not found' }, 404);
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);

    const expirySeconds = expiryStr
      ? parseInt(expiryStr, 10)
      : typeof config.expirySeconds === 'number'
        ? config.expirySeconds
        : 3600;

    const signingCfg = c.get('slingshotCtx').signing;
    if (signingCfg?.presignedUrls) {
      const secret = signingCfg.secret ?? null;
      if (!secret) return c.json({ error: 'Signing secret not configured' }, 501);
      const defaultExpiry =
        typeof signingCfg.presignedUrls === 'object'
          ? (signingCfg.presignedUrls.defaultExpiry ?? expirySeconds)
          : expirySeconds;
      const base = new URL(c.req.url);
      base.pathname = `${basePath}/download/${key}`;
      base.search = '';
      const url = createPresignedUrl(
        base.toString(),
        key,
        { method: 'GET', expiry: defaultExpiry },
        secret,
      );
      const expiresAt = Math.floor(Date.now() / 1000) + defaultExpiry;
      return c.json({ url, expiresAt }, 200);
    }

    // Fallback: adapter.presignGet (S3 only)
    const adapter = getStorageAdapter(c.get('slingshotCtx'));
    if (!adapter?.presignGet) {
      return c.json(
        {
          error:
            'Presigned download URLs not supported. Enable signing.presignedUrls or use an S3 adapter.',
        },
        501,
      );
    }
    const url = await adapter.presignGet(key, { expirySeconds });
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    return c.json({ url, expiresAt }, 200);
  });

  const deleteRoute = createRoute({
    method: 'delete',
    path: `${basePath}/:key{.+}`,
    tags,
    summary: 'Delete an uploaded file',
    request: {
      params: z.object({ key: z.string() }),
    },
    responses: {
      204: { description: 'Deleted' },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      403: {
        description: 'Forbidden — not the owner or unauthorized',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      404: {
        description: 'Key not found in upload registry',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      500: {
        description: 'No storage adapter configured',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  router.openapi(deleteRoute, async c => {
    const adapter = getStorageAdapter(c.get('slingshotCtx'));
    const guardFailure = await getAuthenticatedAccountGuardFailure(c);
    if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
    if (!adapter) return c.json({ error: 'No storage adapter configured' }, 500);
    const { key } = c.req.valid('param');
    const actor = getActor(c);
    const userId = actor.id;
    const tenantId = actor.tenantId;
    const app = c.get('slingshotCtx').app;

    const { allowed, notFound } = await checkUploadAccess(
      'delete',
      key,
      userId,
      tenantId,
      config,
      app,
    );
    if (notFound) return c.json({ error: 'Not found' }, 404);
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);

    await adapter.delete(key);
    await deleteUploadRecord(key, app);
    return c.body(null, 204);
  });

  return router;
};

import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `upload.presignedUrls` sub-section of `CreateServerConfig`.
 *
 * Controls the built-in presigned-URL generation endpoint that allows clients
 * to upload files directly to the configured storage backend without routing
 * the binary through the application server.
 *
 * @remarks
 * **Fields:**
 * - `expirySeconds` — Lifetime of a generated presigned upload URL in seconds.
 *   Defaults to 3600 (1 hour). The storage backend enforces this server-side;
 *   requests using an expired URL are rejected by the backend, not the app.
 * - `path` — URL path at which the presigned-URL generation endpoint is mounted.
 *   Defaults to `"/upload/presign"`. The endpoint responds to `POST` requests
 *   with a JSON body containing the presigned URL and any required fields.
 *
 * Set `upload.presignedUrls` to `false` to disable the presigned-URL endpoint
 * while still using the direct-upload route.
 *
 * @example
 * ```ts
 * upload: {
 *   presignedUrls: {
 *     expirySeconds: 900,
 *     path: '/files/presign',
 *   },
 * }
 * ```
 */
export const uploadPresignedSchema = z.object({
  expirySeconds: z.number().optional(),
  path: z.string().optional(),
});

/**
 * Zod schema for the `upload` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Configures file-upload handling: storage backend, size/type constraints,
 * object-key generation, authorization, and presigned-URL support.
 *
 * @remarks
 * **Fields:**
 * - `storage` — **Required.** Storage adapter instance (e.g. an S3Adapter, GCS
 *   adapter, or local filesystem adapter). The framework calls standard adapter
 *   methods (`put`, `delete`, `presign`) — no specific class is enforced at the
 *   schema level (`z.any()`), but the adapter must implement the `StorageAdapter`
 *   interface at runtime.
 * - `maxFileSize` — Maximum allowed file size in bytes. Requests exceeding this
 *   size are rejected with 413 before the file is read. Defaults to no limit.
 * - `maxFiles` — Maximum number of files accepted per multipart upload request.
 *   Defaults to 1.
 * - `allowedMimeTypes` — Whitelist of accepted MIME type strings. Requests
 *   with a `Content-Type` not in this list are rejected with 415. Glob patterns
 *   are not supported — use exact MIME types (e.g. `"image/png"`). Omit to
 *   accept any MIME type.
 * - `keyPrefix` — Static string prepended to every generated object key. Useful
 *   for organising objects in a shared bucket (e.g. `"uploads/"`). Applied
 *   before `generateKey` when both are set.
 * - `generateKey` — Function `(file: UploadedFile, c: Context) => string`
 *   that produces the full storage key for an uploaded file. When omitted, the
 *   framework generates a UUID-based key. When provided, `keyPrefix` is still
 *   prepended to the returned string.
 * - `tenantScopedKeys` — When `true` and tenancy is configured, the resolved
 *   tenant ID is automatically prepended to every object key, ensuring cross-
 *   tenant key isolation. Defaults to `false`.
 * - `presignedUrls` — Enable the presigned-URL generation endpoint. `true` uses
 *   default options; supply a {@link uploadPresignedSchema} object to customise
 *   expiry and path. `false` disables the endpoint. Omitting defaults to `false`.
 * - `authorization` — Object containing an optional `authorize` hook:
 *   `(file: UploadedFile, c: Context) => boolean | Promise<boolean>`. Called
 *   after authentication middleware, before the file is written to storage.
 *   Return `false` to reject the upload with 403.
 * - `allowExternalKeys` — When `true`, clients may supply an explicit storage
 *   key in the upload request rather than having one generated. Use only when
 *   clients are trusted (e.g. internal services). Defaults to `false`.
 *
 * **Normalization performed at runtime (not by the schema):**
 * - `keyPrefix` trailing slashes are not normalised — supply exactly the prefix
 *   you want (e.g. `"uploads/"` not `"uploads"`).
 * - When `tenantScopedKeys` is `true`, the effective key is
 *   `{tenantId}/{keyPrefix}{generatedKey}`.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * upload: {
 *   storage: new S3Adapter({ bucket: 'my-uploads', region: 'us-east-1' }),
 *   maxFileSize: 10 * 1024 * 1024, // 10 MB
 *   allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
 *   keyPrefix: 'uploads/',
 *   tenantScopedKeys: true,
 *   presignedUrls: { expirySeconds: 600 },
 *   authorization: {
 *     authorize: (file, c) => c.get('user')?.role === 'admin',
 *   },
 * }
 * ```
 */
export const uploadSchema = z.object({
  storage: z.any(),
  maxFileSize: z.number().optional(),
  maxFiles: z.number().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  keyPrefix: z.string().optional(),
  generateKey: fnSchema.optional(),
  tenantScopedKeys: z.boolean().optional(),
  presignedUrls: z.union([z.boolean(), uploadPresignedSchema.loose()]).optional(),
  authorization: z
    .object({
      authorize: fnSchema.optional(),
    })
    .loose()
    .optional(),
  allowExternalKeys: z.boolean().optional(),
});

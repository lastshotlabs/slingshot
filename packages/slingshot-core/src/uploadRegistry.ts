// ---------------------------------------------------------------------------
// Upload Registry — repository contract and types
// ---------------------------------------------------------------------------

/**
 * Metadata record stored when a file is uploaded via the framework upload middleware.
 *
 * Used to verify ownership and tenancy when users request presigned download URLs
 * or initiate delete operations. Stored in the `UploadRegistryRepository`.
 */
export interface UploadRecord {
  /** The storage key (path in the backing object store). Used as the primary lookup key. */
  key: string;
  /**
   * The user ID of the uploader.
   *
   * @remarks
   * `undefined` for unauthenticated uploads (e.g., public file upload endpoints
   * that do not require a session). When present, ownership checks compare this
   * value against the requesting user's session ID. Never `null` — use `undefined`
   * to indicate an anonymous upload.
   */
  ownerUserId?: string;
  /**
   * The tenant ID scope of the upload.
   *
   * @remarks
   * `undefined` for app-wide uploads not scoped to any tenant. When present,
   * download and delete handlers may restrict access to users who are members
   * of the same tenant. Never `null` — use `undefined` for non-tenant-scoped uploads.
   */
  tenantId?: string;
  /**
   * The MIME type of the uploaded file (e.g., `'image/png'`, `'application/pdf'`).
   *
   * @remarks
   * Populated from the `Content-Type` header of the upload request. `undefined`
   * when the MIME type was not provided or could not be determined. Not validated
   * by the registry — the upload middleware is responsible for MIME type
   * verification before registering the record.
   */
  mimeType?: string;
  /**
   * The name of the storage bucket the file was written to.
   *
   * @remarks
   * `undefined` for adapters that do not support multiple buckets (single-bucket
   * configurations). When present, download and delete operations must target
   * the same bucket to locate the file. Bucket names are adapter-defined strings
   * (e.g., `'avatars'`, `'documents'`).
   */
  bucket?: string;
  /** Unix epoch milliseconds when the upload was registered. */
  createdAt: number;
}

/**
 * Storage contract for tracking upload ownership and metadata.
 *
 * Implementations store `UploadRecord` entries keyed by the storage key.
 * The upload middleware calls `register()` after a successful upload.
 * Presigned-download and delete handlers call `get()` to verify ownership.
 *
 * @example
 * ```ts
 * import type { UploadRegistryRepository, UploadRecord } from '@lastshotlabs/slingshot-core';
 *
 * // After upload:
 * await uploadRegistry.register({ key, ownerUserId: userId, createdAt: Date.now() });
 *
 * // Before serving a presigned URL:
 * const record = await uploadRegistry.get(key);
 * if (record?.ownerUserId !== userId) throw new HttpError(403, 'Forbidden');
 * ```
 */
export interface UploadRegistryRepository {
  /**
   * Store a new upload record, keyed by `record.key`.
   *
   * @param record - The full `UploadRecord` to persist. `record.key` is the
   *   primary key — all other fields are metadata. If a record with the same
   *   key already exists it is replaced entirely (upsert semantics).
   * @remarks
   * Called by the upload middleware immediately after a successful file write
   * to the backing object store. The record is used by subsequent download and
   * delete operations to verify ownership and tenancy before granting access.
   */
  register(record: UploadRecord): Promise<void>;
  /**
   * Retrieve an upload record by its storage key.
   *
   * @param key - The storage key to look up (must match `UploadRecord.key` exactly).
   * @returns The `UploadRecord` if found, or `null` if:
   *   - no record with this key has been registered, or
   *   - the record's TTL has expired (for implementations that support TTL-based
   *     expiry — the expired entry is treated as absent and `null` is returned,
   *     not the stale record).
   */
  get(key: string): Promise<UploadRecord | null>;
  /**
   * Delete an upload record by its storage key.
   *
   * @param key - The storage key of the record to remove.
   * @returns `true` if the record existed and was deleted; `false` if no record
   *   with this key was found (safe no-op — does not throw when the key is absent).
   * @remarks
   * Deleting the registry record does not delete the underlying file from the
   * object store — the caller is responsible for removing the file separately.
   * This method only removes the ownership/metadata tracking entry.
   */
  delete(key: string): Promise<boolean>;
}

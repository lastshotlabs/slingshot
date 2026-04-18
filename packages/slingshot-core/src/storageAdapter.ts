/**
 * Pluggable object storage adapter for the upload middleware.
 *
 * Implement this interface to connect any storage backend (S3, R2, local disk, etc.)
 * to the Slingshot upload infrastructure. Registered via the uploads plugin configuration.
 *
 * @example
 * ```ts
 * import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
 * import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
 *
 * export class S3Adapter implements StorageAdapter {
 *   async put(key, data, { mimeType }) {
 *     await s3.send(new PutObjectCommand({ Bucket: 'my-bucket', Key: key, Body: data, ContentType: mimeType }));
 *     return { url: `https://my-bucket.s3.amazonaws.com/${key}` };
 *   }
 *   // ...
 * }
 * ```
 */
export interface StorageAdapter {
  /**
   * Upload an object to the backing store.
   *
   * @param key - The storage key (path/filename in the bucket).
   * @param data - The file data as a Blob, Buffer, or ReadableStream.
   * @param meta - MIME type, byte size, and optional bucket override.
   * @returns An object containing the public `url` of the uploaded object when the
   *   store supports public access (e.g. a public S3 bucket or R2 with a custom domain).
   *   `url` is optional — adapters for private buckets or stores without stable public
   *   URLs should omit it. Callers that need a URL for private objects should use
   *   `presignGet()` instead of relying on `url` from `put()`.
   */
  put(
    key: string,
    data: Blob | Buffer | ReadableStream,
    meta: { mimeType: string; size: number; bucket?: string },
  ): Promise<{ url?: string }>;
  /**
   * Download an object from the backing store.
   *
   * @param key - The storage key to retrieve.
   * @returns A stream and metadata, or `null` if the key does not exist.
   *
   * @remarks
   * The caller is responsible for consuming or cancelling the returned `stream`.
   * Failing to read or cancel the stream may hold open a network connection or
   * file handle in the underlying adapter. Once the stream has been fully consumed
   * or cancelled, the adapter is free to release any associated resources. Do not
   * hold references to the stream after it has been consumed.
   */
  get(key: string): Promise<{ stream: ReadableStream; mimeType?: string; size?: number } | null>;
  /**
   * Delete an object from the backing store.
   * @param key - The storage key to delete.
   */
  delete(key: string): Promise<void>;
  /**
   * Generate a presigned URL that allows a client to upload directly to the backing store.
   * Optional — only implement when the store supports presigned PUT URLs (e.g. S3, R2).
   *
   * @param key - The storage key the upload will be written to.
   * @param opts.expirySeconds - How many seconds until the URL expires. After expiry the
   *   URL returns 403. The URL is a signed HTTPS URL specific to the backing store
   *   (e.g. an AWS pre-signed PUT URL) — its format is opaque to callers.
   * @param opts.mimeType - When provided, the presigned URL enforces this Content-Type on upload.
   * @param opts.maxSize - When provided, the presigned URL enforces a maximum upload size in bytes.
   * @returns The presigned URL string. Expires after `expirySeconds` seconds from generation time.
   */
  presignPut?(
    key: string,
    opts: { expirySeconds: number; mimeType?: string; maxSize?: number },
  ): Promise<string>;
  /**
   * Generate a presigned URL that allows a client to download directly from the backing store.
   * Optional — only implement when the store supports presigned GET URLs.
   *
   * @param key - The storage key of the object to expose.
   * @param opts.expirySeconds - How many seconds until the URL expires. After expiry the
   *   URL returns 403. The URL format is backing-store specific (e.g. an AWS S3 presigned
   *   GET URL with a `X-Amz-Expires` query parameter) — treat it as an opaque string.
   * @returns The presigned URL string. Expires after `expirySeconds` seconds from generation time.
   */
  presignGet?(key: string, opts: { expirySeconds: number }): Promise<string>;
}

/**
 * Metadata about a completed upload, populated by the upload middleware and stored
 * in `c.get('uploadResults')` for route handlers to inspect.
 */
export interface UploadResult {
  /** The storage key assigned to this upload. */
  key: string;
  /** The original filename from the multipart form data. */
  originalName: string;
  /** The MIME type of the uploaded file. */
  mimeType: string;
  /** File size in bytes. */
  size: number;
  /** Public URL returned by the storage adapter (when available). */
  url?: string;
}

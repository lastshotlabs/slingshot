import type { StorageAdapter } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for the S3-compatible storage adapter.
 *
 * Compatible with AWS S3, Cloudflare R2, MinIO, and any S3-compatible endpoint.
 */
export interface S3StorageConfig {
  /** Target S3 bucket name.  Individual `put` calls may override this via `meta.bucket`. */
  bucket: string;
  /**
   * AWS region.  Required for AWS S3; ignored by most S3-compatible providers.
   * Default: `"us-east-1"`.
   */
  region?: string;
  /**
   * Custom endpoint URL for S3-compatible services (e.g. MinIO, Cloudflare R2,
   * LocalStack).  Omit to use the default AWS S3 endpoint.
   */
  endpoint?: string;
  /**
   * Explicit AWS credentials.  When omitted the AWS SDK falls back to its
   * standard credential chain (environment variables, instance metadata, etc.).
   */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /**
   * Base URL for publicly accessible objects.  When set, `put` returns
   * `{ url: "<publicUrl>/<key>" }`.  Leave unset for private buckets that
   * require presigned URLs.
   */
  publicUrl?: string;
  /**
   * Force path-style S3 URLs (`endpoint/bucket/key`) instead of virtual-hosted
   * style (`bucket.endpoint/key`).  Required for MinIO and some other
   * self-hosted S3-compatible services.  Default: `false`.
   */
  forcePathStyle?: boolean;
  /**
   * When `true`, `ReadableStream` bodies are uploaded using the `@aws-sdk/lib-storage`
   * multipart `Upload` helper, which streams without buffering the entire body.
   * Recommended for large file uploads.  Default: `false`.
   */
  streaming?: boolean;
}

interface S3ClientModule {
  S3Client: new (opts: Record<string, unknown>) => S3ClientShape;
  PutObjectCommand: new (params: Record<string, unknown>) => unknown;
  GetObjectCommand: new (params: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (params: Record<string, unknown>) => unknown;
}

interface PresignerModule {
  getSignedUrl: (
    client: S3ClientShape,
    command: unknown,
    opts: Record<string, unknown>,
  ) => Promise<string>;
}

interface LibStorageModule {
  Upload: new (opts: Record<string, unknown>) => { done(): Promise<unknown> };
}

function requireS3Client(): S3ClientModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@aws-sdk/client-s3') as unknown as S3ClientModule;
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed. Run: bun add @aws-sdk/client-s3');
  }
}

function requirePresigner(): PresignerModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@aws-sdk/s3-request-presigner') as unknown as PresignerModule;
  } catch {
    throw new Error(
      '@aws-sdk/s3-request-presigner is not installed. Run: bun add @aws-sdk/s3-request-presigner',
    );
  }
}

function requireLibStorage(): LibStorageModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@aws-sdk/lib-storage') as unknown as LibStorageModule;
  } catch {
    throw new Error('@aws-sdk/lib-storage is not installed. Run: bun add @aws-sdk/lib-storage');
  }
}

/**
 * Create a `StorageAdapter` backed by an S3-compatible object store.
 *
 * The AWS SDK (`@aws-sdk/client-s3`) is loaded lazily on first use so that
 * applications that do not use S3 storage do not pay the import cost.
 * `@aws-sdk/s3-request-presigner` is loaded on first presign call, and
 * `@aws-sdk/lib-storage` is loaded on first streaming upload.  If a required
 * package is missing an informative error is thrown at the point of first use.
 *
 * The S3Client instance is created once and reused across all operations
 * (lazy singleton, closure-owned — no module-level state).
 *
 * @param config - S3 storage configuration.  See {@link S3StorageConfig}.
 * @returns A `StorageAdapter` with `put`, `get`, `delete`, `presignPut`, and
 *   `presignGet` operations backed by the configured S3-compatible store.
 * @throws {Error} At first use if `@aws-sdk/client-s3` (or the presigner /
 *   lib-storage packages) is not installed.
 * @throws Re-throws any S3 SDK error except `NoSuchKey` (404) from `get`, which
 *   is normalised to a `null` return value.
 *
 * @example
 * ```ts
 * const storage = s3Storage({
 *   bucket: 'my-uploads',
 *   region: 'us-east-1',
 *   publicUrl: 'https://cdn.example.com',
 * });
 * ```
 */
interface S3ClientShape {
  send(command: unknown): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }>;
}

export const s3Storage = (config: S3StorageConfig): StorageAdapter => {
  let _client: S3ClientShape | null = null;

  const getClient = (): S3ClientShape => {
    if (!_client) {
      const { S3Client } = requireS3Client();
      _client = new S3Client({
        region: config.region ?? 'us-east-1',
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        ...(config.credentials ? { credentials: config.credentials } : {}),
        ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      });
    }
    return _client;
  };

  return {
    async put(key, data, meta) {
      const bucket = meta.bucket ?? config.bucket;
      const client = getClient();

      if (config.streaming && data instanceof ReadableStream) {
        const { Upload } = requireLibStorage();
        const upload = new Upload({
          client,
          params: {
            Bucket: bucket,
            Key: key,
            Body: data,
            ContentType: meta.mimeType,
          },
        });
        await upload.done();
      } else {
        const { PutObjectCommand } = requireS3Client();
        let body: Buffer | Uint8Array | Blob;
        if (data instanceof ReadableStream) {
          const response = new Response(data);
          body = Buffer.from(await response.arrayBuffer());
        } else if (data instanceof Blob) {
          body = Buffer.from(await data.arrayBuffer());
        } else {
          body = data;
        }
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: meta.mimeType,
            ContentLength: meta.size,
          }),
        );
      }

      const url = config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${key}` : undefined;
      return { ...(url !== undefined ? { url } : {}) };
    },

    async get(key) {
      const { GetObjectCommand } = requireS3Client();
      const client = getClient();
      const bucket = config.bucket;
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return {
          stream: result.Body as ReadableStream,
          mimeType: result.ContentType,
          size: result.ContentLength,
        };
      } catch (err: unknown) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async delete(key) {
      const { DeleteObjectCommand } = requireS3Client();
      const client = getClient();
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    presignPut(key, opts) {
      const { PutObjectCommand } = requireS3Client();
      const { getSignedUrl } = requirePresigner();
      const client = getClient();
      const params: Record<string, unknown> = {
        Bucket: config.bucket,
        Key: key,
        ...(opts.mimeType ? { ContentType: opts.mimeType } : {}),
      };
      return getSignedUrl(client, new PutObjectCommand(params), { expiresIn: opts.expirySeconds });
    },

    presignGet(key, opts) {
      const { GetObjectCommand } = requireS3Client();
      const { getSignedUrl } = requirePresigner();
      const client = getClient();
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: opts.expirySeconds,
      });
    },
  };
};

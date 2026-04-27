import { createRequire } from 'node:module';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';

const require = createRequire(import.meta.url);

/**
 * Configuration for the S3-compatible storage adapter.
 *
 * Compatible with AWS S3, Cloudflare R2, MinIO, and any S3-compatible endpoint.
 */
export interface S3StorageConfig {
  /** Target S3 bucket name. Individual `put` calls may override this via `meta.bucket`. */
  readonly bucket: string;
  /**
   * AWS region. Required for AWS S3; ignored by most S3-compatible providers.
   * Defaults to `'us-east-1'`.
   */
  readonly region?: string;
  /**
   * Custom endpoint URL for S3-compatible services such as MinIO or Cloudflare R2.
   */
  readonly endpoint?: string;
  /**
   * Explicit AWS credentials.
   *
   * When omitted, the AWS SDK falls back to its standard credential chain.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  /**
   * Base URL for publicly accessible objects.
   *
   * When set, `put()` returns `{ url }` built from this base plus the storage key.
   */
  readonly publicUrl?: string;
  /**
   * Force path-style S3 URLs (`endpoint/bucket/key`) instead of virtual-hosted URLs.
   */
  readonly forcePathStyle?: boolean;
  /**
   * When `true`, `ReadableStream` uploads use `@aws-sdk/lib-storage` multipart upload.
   */
  readonly streaming?: boolean;
  /**
   * Number of attempts for `put()` and `delete()` operations before propagating
   * the error. Each retry waits `attempt × 500 ms` before retrying. Default: 3.
   */
  readonly retryAttempts?: number;
}

interface S3ClientShape {
  send(command: unknown): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }>;
}

interface S3ClientModule {
  S3Client: new (opts: Record<string, unknown>) => S3ClientShape;
  PutObjectCommand: new (params: Record<string, unknown>) => unknown;
  GetObjectCommand: new (params: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (params: Record<string, unknown>) => unknown;
}

interface PresignerModule {
  getSignedUrl(
    client: S3ClientShape,
    command: unknown,
    opts: Record<string, unknown>,
  ): Promise<string>;
}

interface LibStorageModule {
  Upload: new (opts: Record<string, unknown>) => { done(): Promise<unknown> };
}

function requireS3Client(): S3ClientModule {
  try {
    return require('@aws-sdk/client-s3') as S3ClientModule;
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed. Run: bun add @aws-sdk/client-s3');
  }
}

function requirePresigner(): PresignerModule {
  try {
    return require('@aws-sdk/s3-request-presigner') as PresignerModule;
  } catch {
    throw new Error(
      '@aws-sdk/s3-request-presigner is not installed. Run: bun add @aws-sdk/s3-request-presigner',
    );
  }
}

function requireLibStorage(): LibStorageModule {
  try {
    return require('@aws-sdk/lib-storage') as LibStorageModule;
  } catch {
    throw new Error('@aws-sdk/lib-storage is not installed. Run: bun add @aws-sdk/lib-storage');
  }
}

/**
 * Retry a potentially-failing async operation with linear back-off.
 *
 * Attempts `fn` up to `attempts` times. On each failure (except the last),
 * waits `attempt × delayMs` milliseconds before the next try. The final
 * failure is rethrown to the caller.
 *
 * @param fn - The async operation to run.
 * @param attempts - Maximum number of tries. Default: 3.
 * @param delayMs - Base delay in milliseconds. Actual wait = `attempt × delayMs`.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise<void>(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  // unreachable — loop always throws or returns before here
  throw new Error('[s3Storage] withRetry: unreachable');
}

/**
 * Create a `StorageAdapter` backed by an S3-compatible object store.
 *
 * AWS SDK modules are loaded lazily so apps that do not use S3 avoid the import cost.
 *
 * @param config - S3 storage configuration.
 * @returns A storage adapter that supports upload, download, delete, and presign operations.
 */
export function s3Storage(config: S3StorageConfig): StorageAdapter {
  let clientRef: S3ClientShape | null = null;
  const retryAttempts = config.retryAttempts ?? 3;

  function getClient(): S3ClientShape {
    if (clientRef) return clientRef;

    const { S3Client } = requireS3Client();
    clientRef = new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    });
    return clientRef;
  }

  return {
    async put(key, data, meta) {
      const bucket = meta.bucket ?? config.bucket;
      const client = getClient();

      await withRetry(async () => {
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
          let body: Blob | Buffer | Uint8Array;

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
      }, retryAttempts);

      const url = config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${key}` : undefined;
      return url === undefined ? {} : { url };
    },

    async get(key) {
      const { GetObjectCommand } = requireS3Client();

      try {
        const result = await getClient().send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return {
          stream: result.Body as ReadableStream,
          mimeType: result.ContentType,
          size: result.ContentLength,
        };
      } catch (error: unknown) {
        const typed = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (typed.name === 'NoSuchKey' || typed.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },

    async delete(key) {
      const { DeleteObjectCommand } = requireS3Client();
      await withRetry(
        () => getClient().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })),
        retryAttempts,
      );
    },

    async presignPut(key, opts) {
      const { PutObjectCommand } = requireS3Client();
      const presigner = requirePresigner();
      const params: Record<string, unknown> = {
        Bucket: config.bucket,
        Key: key,
        ...(opts.mimeType ? { ContentType: opts.mimeType } : {}),
      };
      return presigner.getSignedUrl(getClient(), new PutObjectCommand(params), {
        expiresIn: opts.expirySeconds,
      });
    },

    async presignGet(key, opts) {
      const { GetObjectCommand } = requireS3Client();
      const presigner = requirePresigner();
      return presigner.getSignedUrl(
        getClient(),
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: opts.expirySeconds },
      );
    },
  };
}

import type { RegistryDocument, RegistryLock, RegistryProvider } from '../types/registry';
import { createEmptyRegistryDocument } from '../types/registry';

/**
 * Configuration for the S3-backed registry provider.
 */
export interface S3RegistryConfig {
  /**
   * S3 bucket name.
   *
   * The bucket does not need to exist beforehand — `initialize()` will create
   * it (with versioning enabled) if it is absent. For pre-existing buckets,
   * `initialize()` is a no-op regarding bucket creation but will still enable
   * versioning and seed an empty registry document if none exists.
   */
  bucket: string;
  /**
   * Object key prefix applied to all objects written to the bucket.
   *
   * The registry document is stored at `<prefix>registry.json`.
   * Default: `'slingshot-registry/'`.
   */
  prefix?: string;
  /**
   * AWS region for the `S3Client` instance.
   *
   * Must match the region where `bucket` was created. For `us-east-1` the
   * `CreateBucketConfiguration` constraint is omitted (AWS requirement).
   * Default: `'us-east-1'`.
   */
  region?: string;
  /**
   * Custom endpoint URL for S3-compatible providers (LocalStack, MinIO,
   * DigitalOcean Spaces, Ceph, etc.).
   *
   * When set, this overrides the default AWS S3 endpoint. Typically used
   * together with `forcePathStyle: true` for providers that do not support
   * virtual-hosted-style bucket addressing.
   */
  endpoint?: string;
  /**
   * Use path-style bucket addressing (`http://endpoint/bucket/key`) instead of
   * virtual-hosted-style (`http://bucket.endpoint/key`).
   *
   * Required for S3-compatible providers that do not support virtual-hosted
   * bucket names (LocalStack, MinIO). Default: `false`.
   */
  forcePathStyle?: boolean;
}

/**
 * Create a registry provider that persists the `RegistryDocument` as a single
 * JSON object in an S3 bucket.
 *
 * Optimistic concurrency is provided via ETags: `write()` passes `IfMatch` to
 * S3 when an etag is supplied. Uses lazy-loaded `@aws-sdk/client-s3`; the
 * package must be installed as an optional peer dependency.
 *
 * `initialize()` creates the bucket (if absent) and enables versioning, then
 * writes an empty registry document if none exists.
 *
 * @param config - S3 bucket, prefix, and region.
 * @returns A `RegistryProvider` backed by S3.
 *
 * @throws {Error} If `@aws-sdk/client-s3` is not installed
 *   (message: `'@aws-sdk/client-s3 is not installed'`).
 * @throws {Error} If AWS credentials are missing or lack permission to access
 *   the bucket — propagated directly from the AWS SDK.
 * @throws {Error} If `write()` is called with a stale ETag and S3 rejects the
 *   conditional `IfMatch` header (optimistic concurrency conflict).
 *
 * @example
 * ```ts
 * import { createS3Registry } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createS3Registry({
 *   bucket: 'my-org-slingshot-registry',
 *   region: 'us-east-1',
 * });
 * await registry.initialize();
 * ```
 */
export function createS3Registry(config: S3RegistryConfig): RegistryProvider {
  const prefix = config.prefix ?? 'slingshot-registry/';
  const key = `${prefix}registry.json`;
  let cachedEtag: string | undefined;

  function parseRegistryDocument(content: string): RegistryDocument {
    return JSON.parse(content) as RegistryDocument;
  }

  /**
   * Lazily import `@aws-sdk/client-s3`, surfacing a clear error message if the
   * optional peer dependency is not installed.
   *
   * @returns The full `@aws-sdk/client-s3` module namespace.
   *
   * @throws {Error} If the package is not installed
   *   (message: `'@aws-sdk/client-s3 is not installed. Run: bun add @aws-sdk/client-s3'`).
   */
  async function loadS3(): Promise<typeof import('@aws-sdk/client-s3')> {
    try {
      return await import('@aws-sdk/client-s3');
    } catch {
      throw new Error('@aws-sdk/client-s3 is not installed. Run: bun add @aws-sdk/client-s3');
    }
  }

  /**
   * Create a new `S3Client` instance scoped to `config.region`.
   *
   * A fresh client is created on each call. Callers that need to reuse a
   * client across multiple operations within a single method should call this
   * once and pass the result through, rather than calling it multiple times.
   *
   * @returns A configured `S3Client` instance.
   *
   * @throws {Error} If `@aws-sdk/client-s3` is not installed (via `loadS3`).
   */
  async function getClient() {
    const { S3Client } = await loadS3();
    return new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  return {
    name: 's3',

    async read(): Promise<RegistryDocument | null> {
      const client = await getClient();
      const { GetObjectCommand } = await loadS3();
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        cachedEtag = res.ETag;
        const body = await res.Body?.transformToString();
        return body ? parseRegistryDocument(body) : null;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'name' in err &&
          (err.name === 'NoSuchKey' || err.name === 'NoSuchBucket' || err.name === 'NotFound')
        ) {
          return null;
        }
        throw err;
      }
    },

    async write(doc: RegistryDocument, etag?: string): Promise<{ etag: string }> {
      const client = await getClient();
      const { PutObjectCommand } = await loadS3();
      const res = await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: JSON.stringify(doc, null, 2),
          ContentType: 'application/json',
          ...(etag ? { IfMatch: etag } : {}),
        }),
      );
      cachedEtag = res.ETag;
      return { etag: cachedEtag ?? '' };
    },

    async initialize(): Promise<void> {
      const client = await getClient();
      const { CreateBucketCommand, HeadBucketCommand, PutBucketVersioningCommand } = await loadS3();
      const region = config.region ?? 'us-east-1';

      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch {
        // Bucket does not exist yet — create it
        await client.send(
          new CreateBucketCommand({
            Bucket: config.bucket,
            ...(region !== 'us-east-1'
              ? {
                  CreateBucketConfiguration: {
                    LocationConstraint:
                      region as import('@aws-sdk/client-s3').BucketLocationConstraint,
                  },
                }
              : {}),
          }),
        );
      }

      await client.send(
        new PutBucketVersioningCommand({
          Bucket: config.bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );

      const existing = await this.read();
      if (!existing) {
        const initial = createEmptyRegistryDocument('');
        await this.write(initial);
      }
    },

    async lock(): Promise<RegistryLock> {
      if (!cachedEtag) {
        await this.read();
      }
      const etag = cachedEtag ?? '';
      return {
        etag,
        async release() {},
      };
    },
  };
}

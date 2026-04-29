import { createRequire } from 'node:module';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';

const require = createRequire(import.meta.url);

/**
 * Static AWS credentials object. Use this only when credentials never change
 * during the process lifetime. For long-running services prefer a
 * {@link AwsCredentialProvider} so STS/EC2/ECS rotation is honored.
 */
export interface AwsStaticCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

/**
 * AWS credential provider — async function the SDK calls each time it needs
 * fresh credentials. The SDK caches the result until `expiration` passes.
 *
 * Plug this in when you load credentials from a secret manager or rotate them
 * periodically. Without this (and without {@link AwsStaticCredentials}), the
 * SDK uses its default credential chain (env, profile, EC2/ECS metadata, STS
 * web identity) which already refreshes automatically.
 */
export type AwsCredentialProvider = () => Promise<AwsStaticCredentials>;

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
   * Credentials. Either a static value (no rotation) or a provider function the
   * SDK invokes to refresh credentials before they expire.
   *
   * Omit to use the SDK's default credential chain (env, EC2/ECS metadata,
   * STS web identity), which refreshes automatically.
   */
  readonly credentials?: AwsStaticCredentials | AwsCredentialProvider;
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
  /**
   * Circuit breaker — number of consecutive failed operations (after retries
   * exhaust) before the breaker opens and short-circuits subsequent calls.
   * Default: 5.
   */
  readonly circuitBreakerThreshold?: number;
  /**
   * Circuit breaker — cooldown duration in ms before allowing a half-open
   * probe after the breaker opens. Default: 30 000 ms.
   */
  readonly circuitBreakerCooldownMs?: number;
  /**
   * Circuit breaker — clock used for cooldown comparisons. Override in tests
   * for deterministic state machines. Default: `Date.now`.
   */
  readonly now?: () => number;
}

interface S3ClientShape {
  send(command: unknown): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }>;
}

interface S3ClientModule {
  S3Client: new (opts: Record<string, unknown>) => S3ClientShape;
  PutObjectCommand: new (params: Record<string, unknown>) => unknown;
  GetObjectCommand: new (params: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (params: Record<string, unknown>) => unknown;
  CreateMultipartUploadCommand: new (params: Record<string, unknown>) => unknown;
  UploadPartCommand: new (params: Record<string, unknown>) => unknown;
  CompleteMultipartUploadCommand: new (params: Record<string, unknown>) => unknown;
  AbortMultipartUploadCommand: new (params: Record<string, unknown>) => unknown;
}

interface PresignerModule {
  getSignedUrl(
    client: S3ClientShape,
    command: unknown,
    opts: Record<string, unknown>,
  ): Promise<string>;
}

interface LibStorageUpload {
  done(): Promise<unknown>;
  abort(): Promise<unknown>;
}

interface LibStorageModule {
  Upload: new (opts: Record<string, unknown>) => LibStorageUpload;
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
 * Structured error thrown when the S3 circuit breaker is open. Callers can
 * pattern-match on `code === 'S3_CIRCUIT_OPEN'` to fail fast without waiting
 * for the underlying request retries.
 */
export class S3CircuitOpenError extends Error {
  readonly code = 'S3_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'S3CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Snapshot of the S3 adapter circuit breaker state. */
export interface S3CircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

interface S3CircuitBreaker {
  /**
   * Run `fn` through the breaker. When the breaker is open and the cooldown
   * has not yet elapsed, throws `S3CircuitOpenError` without invoking `fn`.
   * Otherwise runs `fn`; success closes the breaker, failure feeds the
   * consecutive-failure counter and may trip it open.
   */
  guard<T>(fn: () => Promise<T>, op: string): Promise<T>;
  getHealth(): S3CircuitBreakerHealth;
}

/**
 * Construct the S3 adapter circuit breaker.
 *
 * State machine mirrors the search provider breaker so the two surfaces
 * behave identically under sustained outages:
 *   closed    — normal operation; failures increment a counter
 *   open      — fail fast; reject every request until cooldown elapses
 *   half-open — let exactly one probe through; success resets, failure re-opens
 *
 * Retried operations count as a single breaker-failure (we feed the breaker
 * after retries exhaust, not per attempt) so a transient blip that recovers
 * inside `retryAttempts` does not trip the breaker.
 */
function createS3CircuitBreaker(opts: {
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly now: () => number;
}): S3CircuitBreaker {
  const { threshold, cooldownMs, now } = opts;

  let state: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getHealth(): S3CircuitBreakerHealth {
    const nextProbeAt =
      state === 'open' && openedAt !== undefined ? openedAt + cooldownMs : undefined;
    return { state, consecutiveFailures, openedAt, nextProbeAt };
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    state = 'closed';
    openedAt = undefined;
    halfOpenInFlight = false;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (state === 'half-open') {
      // Probe failed — reopen and back off again.
      state = 'open';
      openedAt = now();
      halfOpenInFlight = false;
      return;
    }
    if (consecutiveFailures >= threshold && state === 'closed') {
      state = 'open';
      openedAt = now();
    }
  }

  function tryEnterHalfOpen(): boolean {
    if (state !== 'open') return true;
    if (openedAt === undefined) return true;
    if (now() - openedAt < cooldownMs) return false;
    if (halfOpenInFlight) return false;
    state = 'half-open';
    halfOpenInFlight = true;
    return true;
  }

  async function guard<T>(fn: () => Promise<T>, op: string): Promise<T> {
    if (!tryEnterHalfOpen()) {
      const retryAfterMs = openedAt !== undefined ? Math.max(0, openedAt + cooldownMs - now()) : 0;
      throw new S3CircuitOpenError(
        `[slingshot-assets:s3] Circuit breaker open after ${consecutiveFailures} ` +
          `consecutive failures. Retrying in ~${retryAfterMs}ms. Operation: ${op}`,
        retryAfterMs,
      );
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  return { guard, getHealth };
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
 * S3 storage adapter augmented with circuit breaker observability.
 *
 * The returned object satisfies `StorageAdapter` and exposes a stable
 * `getCircuitBreakerHealth()` helper so callers (health endpoints, metrics)
 * can surface breaker state without poking at internals.
 */
export interface S3StorageAdapter extends StorageAdapter {
  /** Inspect the circuit breaker — stable observability surface. */
  getCircuitBreakerHealth(): S3CircuitBreakerHealth;

  /**
   * Initiate a multipart upload and return the upload ID.
   *
   * Callers use the returned `uploadId` to generate presigned part URLs,
   * then complete or abort the upload once all parts have been transferred.
   *
   * @param key - The storage key for the final object.
   * @param opts - Upload options such as MIME type.
   * @returns The upload ID assigned by S3.
   */
  initiateMultipartUpload?(
    key: string,
    opts: { mimeType?: string; bucket?: string },
  ): Promise<{ uploadId: string }>;

  /**
   * Generate a presigned URL for uploading a single part of a multipart upload.
   *
   * The URL is valid for `expirySeconds` from generation. The caller must use
   * the returned URL to PUT the part body (with the corresponding part number).
   *
   * @param key - The storage key of the object being uploaded.
   * @param uploadId - The upload ID returned by `initiateMultipartUpload`.
   * @param partNumber - The part number (1-based).
   * @param opts - Expiry for the presigned URL.
   * @returns The presigned URL string for uploading the part.
   */
  presignUploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    opts: { expirySeconds: number },
  ): Promise<string>;

  /**
   * Complete a multipart upload by assembling the uploaded parts into the final object.
   *
   * @param key - The storage key of the object.
   * @param uploadId - The upload ID returned by `initiateMultipartUpload`.
   * @param parts - Array of completed parts with ETags and part numbers.
   * @returns An optional public URL for the completed object.
   */
  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ ETag: string; PartNumber: number }>,
  ): Promise<{ url?: string }>;

  /**
   * Abort a multipart upload and discard any uploaded parts.
   *
   * Call this when the upload is no longer needed (e.g. the client disconnected
   * or the operation timed out) to avoid storage costs for orphaned parts.
   *
   * @param key - The storage key of the object.
   * @param uploadId - The upload ID to abort.
   */
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
}

/**
 * Create a `StorageAdapter` backed by an S3-compatible object store.
 *
 * AWS SDK modules are loaded lazily so apps that do not use S3 avoid the import cost.
 *
 * @param config - S3 storage configuration.
 * @returns A storage adapter that supports upload, download, delete, and presign operations.
 *
 * @remarks
 * **Circuit breaker** — the adapter wraps every S3 call (put/get/delete and
 * presign-get) in a circuit breaker. After `circuitBreakerThreshold`
 * consecutive operation failures (each one already retried up to
 * `retryAttempts` times) the breaker opens for `circuitBreakerCooldownMs`
 * and rejects subsequent calls with `S3CircuitOpenError` (`code:
 * 'S3_CIRCUIT_OPEN'`) until the cooldown elapses, then admits a single
 * half-open probe. This prevents a sustained S3 outage from amplifying load
 * against a struggling provider.
 *
 * `presignPut()` is intentionally **not** breaker-gated: it is a local
 * signing operation that does not touch S3 servers. `presignGet()` is gated
 * because the current implementation routes through `withRetry` and could
 * (in some SDK versions) trigger STS lookups.
 */
export function s3Storage(config: S3StorageConfig): S3StorageAdapter {
  let clientRef: S3ClientShape | null = null;
  const retryAttempts = config.retryAttempts ?? 3;
  const breaker = createS3CircuitBreaker({
    threshold: config.circuitBreakerThreshold ?? 5,
    cooldownMs: config.circuitBreakerCooldownMs ?? 30_000,
    now: config.now ?? (() => Date.now()),
  });

  function getClient(): S3ClientShape {
    if (clientRef) return clientRef;

    const { S3Client } = requireS3Client();
    clientRef = new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Pass credentials as-is: the SDK accepts both static objects and
      // provider functions, and refreshes via provider.expiration.
      ...(config.credentials ? { credentials: config.credentials } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    });
    return clientRef;
  }

  return {
    getCircuitBreakerHealth: () => breaker.getHealth(),

    async put(key, data, meta) {
      const bucket = meta.bucket ?? config.bucket;
      const client = getClient();

      await breaker.guard(
        () =>
          withRetry(async () => {
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
              try {
                await upload.done();
              } catch (err) {
                // lib-storage usually aborts in-flight multipart on error, but
                // explicitly abort here to defend against partial-upload bills.
                try {
                  await upload.abort();
                } catch {
                  // already aborted or never started — ignore
                }
                throw err;
              }
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
          }, retryAttempts),
        'put',
      );

      const url = config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${key}` : undefined;
      return url === undefined ? {} : { url };
    },

    async get(key) {
      const { GetObjectCommand } = requireS3Client();
      return breaker.guard(
        () =>
          withRetry(async () => {
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
          }, retryAttempts),
        'get',
      );
    },

    async delete(key) {
      const { DeleteObjectCommand } = requireS3Client();
      await breaker.guard(
        () =>
          withRetry(
            () => getClient().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })),
            retryAttempts,
          ),
        'delete',
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
      // Note: presignPut is a local signing op — not breaker-gated.
      return presigner.getSignedUrl(getClient(), new PutObjectCommand(params), {
        expiresIn: opts.expirySeconds,
      });
    },

    async presignGet(key, opts) {
      const { GetObjectCommand } = requireS3Client();
      const presigner = requirePresigner();
      return breaker.guard(
        () =>
          withRetry(
            () =>
              presigner.getSignedUrl(
                getClient(),
                new GetObjectCommand({ Bucket: config.bucket, Key: key }),
                { expiresIn: opts.expirySeconds },
              ),
            retryAttempts,
          ),
        'presignGet',
      );
    },

    // --- Multipart upload support ---

    async initiateMultipartUpload(key, opts) {
      const { CreateMultipartUploadCommand } = requireS3Client();
      const bucket = opts.bucket ?? config.bucket;
      const result = await getClient().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ...(opts.mimeType ? { ContentType: opts.mimeType } : {}),
        }),
      );
      const uploadId =
        typeof result === 'object' &&
        result !== null &&
        'UploadId' in result &&
        typeof (result as Record<string, unknown>).UploadId === 'string'
          ? (result as Record<string, string>).UploadId
          : '';
      return { uploadId };
    },

    async presignUploadPart(key, uploadId, partNumber, opts) {
      const { UploadPartCommand } = requireS3Client();
      const presigner = requirePresigner();
      return presigner.getSignedUrl(
        getClient(),
        new UploadPartCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: opts.expirySeconds },
      );
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const { CompleteMultipartUploadCommand } = requireS3Client();
      const result = await getClient().send(
        new CompleteMultipartUploadCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map(p => ({ ETag: p.ETag, PartNumber: p.PartNumber })) },
        }),
      );
      const location =
        typeof result === 'object' &&
        result !== null &&
        'Location' in result &&
        typeof (result as Record<string, unknown>).Location === 'string'
          ? (result as Record<string, string>).Location
          : undefined;
      return location ? { url: location } : {};
    },

    async abortMultipartUpload(key, uploadId) {
      const { AbortMultipartUploadCommand } = requireS3Client();
      await getClient().send(
        new AbortMultipartUploadCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    },
  };
}

/**
 * Registry entry for a deployed app (for cross-repo coordination).
 *
 * Written by `registerApp()` and read by `getAppsByStack()` /
 * `getAppsByResource()`. Enables platform operators to discover which repos
 * deploy to which stacks and consume which shared resources.
 */
export interface RegistryAppEntry {
  /** Human-readable app name. Must be unique across all apps in the registry. */
  name: string;
  /**
   * Repository URL or identifier used to locate the source code.
   * Conventionally a GitHub path (e.g. `'github.com/acme/api'`) but any string is accepted.
   */
  repo: string;
  /** Names of stacks this app deploys to (keys of `RegistryDocument.stacks`). */
  stacks: string[];
  /**
   * Names of shared resources this app consumes (keys of `RegistryDocument.resources`).
   * Matches the `uses` array from `slingshot.infra.ts`.
   */
  uses: string[];
  /** ISO 8601 timestamp of the last `registerApp()` call. Overwritten on every registration. */
  registeredAt: string;
}

/**
 * The top-level document stored by all `RegistryProvider` implementations.
 *
 * Contains versioned state for stacks, resources, services, and apps.
 * Created with `createEmptyRegistryDocument()` and mutated exclusively through
 * the registry helper functions (`registerApp`, `runDeployPipeline`, etc.).
 */
export interface RegistryDocument {
  /**
   * Schema version for forward-compatibility checks.
   * Currently always `1`. A version mismatch causes the CLI to abort with a
   * migration prompt.
   */
  version: number;
  /** Platform identifier this document belongs to. Matches `DefinePlatformConfig.name`. */
  platform: string;
  /** ISO 8601 timestamp of the last successful write to the registry. */
  updatedAt: string;
  /**
   * Stack provisioning state, keyed by stack name.
   * Keys match the stack names defined in `DefinePlatformConfig.stacks`.
   */
  stacks: Record<string, RegistryStackEntry>;
  /**
   * Resource provisioning state, keyed by resource name.
   * Keys match the resource names defined in `DefinePlatformConfig.resources`.
   */
  resources: Record<string, RegistryResourceEntry>;
  /**
   * Service deploy state, keyed by service name.
   * Keys are logical service names (`'default'` for single-service apps, or
   * the service name from `DefineInfraConfig.services` for multi-service apps).
   */
  services: Record<string, RegistryServiceEntry>;
  /**
   * Apps registered for cross-repo coordination. Keyed by app name.
   * Absent until the first `registerApp()` call.
   */
  apps?: Record<string, RegistryAppEntry>;
  /**
   * Serialized platform config distributed to consumer repos via `slingshot platform pull`.
   * Absent until `slingshot platform push` has been run at least once.
   */
  platformConfig?: import('./platform').DefinePlatformConfig;
}

/**
 * Per-stack infrastructure state entry in the registry.
 */
export interface RegistryStackEntry {
  /**
   * Preset used by this stack (e.g. `'ecs'` or `'ec2-nginx'`).
   * Must match a registered `PresetProvider.name`.
   */
  preset: string;
  /**
   * Per-stage provisioning state, keyed by stage name (e.g. `'production'`, `'staging'`).
   *
   * - `status: 'active'` — infrastructure is provisioned and ready.
   * - `status: 'destroying'` — teardown is in progress.
   * - `status: 'failed'` — last provisioning or destroy attempt failed.
   * - `outputs` — infrastructure key-value outputs (e.g. ALB ARN, EC2 IP).
   * - `updatedAt` — ISO 8601 timestamp of the last status change.
   */
  stages: Record<
    string,
    {
      status: 'active' | 'destroying' | 'failed';
      outputs: Record<string, string>;
      updatedAt: string;
    }
  >;
}

/**
 * Per-resource provisioning state entry in the registry.
 */
export interface RegistryResourceEntry {
  /**
   * Resource type identifier.
   * Must match a registered `ResourceProvisioner.resourceType` (e.g. `'postgres'`, `'redis'`, `'mongo'`).
   */
  type: string;
  /**
   * Per-stage provisioning state, keyed by stage name (e.g. `'production'`, `'staging'`).
   *
   * - `status: 'provisioned'` — resource is ready; `outputs` contains connection details.
   * - `status: 'provisioning'` — creation is in progress.
   * - `status: 'failed'` — last provisioning attempt failed; `outputs` may contain an `error` key.
   * - `outputs` — raw key-value outputs stored in the registry (host, port, credentials).
   * - `provisionedAt` — ISO 8601 timestamp of the last successful provisioning.
   */
  stages: Record<
    string,
    {
      status: 'provisioned' | 'provisioning' | 'failed';
      outputs: Record<string, string>;
      provisionedAt: string;
    }
  >;
}

/**
 * Per-service deploy state entry in the registry.
 *
 * Written by `updateRegistryService()` after every deploy. Stores the current
 * image tag, a `previousTags` history for rollbacks, and service metadata
 * (port, domain, env) for sibling service compose generation.
 */
export interface RegistryServiceEntry {
  /**
   * Name of the stack this service is deployed to.
   * Must be a key in `RegistryDocument.stacks`.
   */
  stack: string;
  /**
   * Repository identifier for cross-repo coordination.
   * Conventionally a GitHub path (e.g. `'github.com/acme/api'`).
   */
  repo: string;
  /**
   * Names of shared resources this service consumes.
   * Matches the `uses` array from `slingshot.infra.ts`.
   */
  uses: string[];
  /**
   * Environment variables needed to run the service.
   * Injected into the docker-compose config when this service is included as
   * a sibling in another app's compose generation.
   */
  env?: Record<string, string>;
  /**
   * Port the container listens on.
   * Used by the EC2/nginx preset when generating the composite docker-compose
   * and Caddyfile for sibling services.
   */
  port?: number;
  /**
   * Public domain assigned to this service (e.g. `'api.example.com'`).
   * Used by the reverse-proxy config generator to route traffic.
   */
  domain?: string;
  /**
   * Full image URI including tag (e.g. `'123456.dkr.ecr.us-east-1.amazonaws.com/api:20240101-abc'`).
   * Written after every successful image push.
   */
  image?: string;
  /**
   * Per-stage deploy history, keyed by stage name.
   *
   * - `imageTag` — Docker image tag of the most recent deploy for this stage.
   * - `deployedAt` — ISO 8601 timestamp of that deploy.
   * - `status` — `'deployed'` (success), `'deploying'` (in progress), or `'failed'`.
   * - `previousTags` — Ordered history of prior image tags, used for rollbacks.
   */
  stages: Record<
    string,
    {
      imageTag: string;
      deployedAt: string;
      status: 'deployed' | 'deploying' | 'failed';
      previousTags?: Array<{ imageTag: string; deployedAt: string }>;
    }
  >;
}

/**
 * Registry storage backend interface.
 *
 * All implementations must provide optimistic-concurrency writes via ETags,
 * an `initialize()` method for first-run setup, and a `lock()` method that
 * returns an ETag-bearing lock object for atomic read-modify-write sequences.
 *
 * @remarks
 * Use `createRegistryFromConfig()` to obtain a `RegistryProvider` rather than
 * implementing this interface directly.
 */
export interface RegistryProvider {
  /**
   * Unique identifier for this provider (e.g. `'s3'`, `'local'`).
   *
   * @remarks
   * Must be unique across all registered `RegistryProvider` implementations.
   * Used for diagnostic output and error messages.
   */
  readonly name: string;

  /**
   * Read the current registry document.
   *
   * @returns The stored `RegistryDocument`, or `null` if the registry has not
   *   been initialized yet (i.e. no document exists at the storage location).
   *
   * @throws {Error} If the storage backend is unreachable or returns an
   *   unexpected error (e.g. S3 access denied, file permission error).
   */
  read(): Promise<RegistryDocument | null>;

  /**
   * Write a new or updated registry document.
   *
   * @remarks
   * **Optimistic concurrency:** When `etag` is provided, the write is
   * conditional — it throws if the document currently in storage has a
   * different ETag (i.e. another process has written since the last read).
   * Always obtain the ETag from `lock()` or the previous `write()` result
   * before mutating the document to prevent lost updates.
   *
   * @param doc - The document to store. Must be a valid `RegistryDocument`.
   * @param etag - Optional ETag from a prior `read()` or `lock()` call.
   *   Omit to perform an unconditional write (not recommended in concurrent contexts).
   * @returns An object containing the new `etag` for the stored document.
   *
   * @throws {Error} If `etag` is provided and the stored document's ETag
   *   does not match (message contains `'ETag mismatch'` or similar).
   * @throws {Error} If the storage backend is unreachable.
   */
  write(doc: RegistryDocument, etag?: string): Promise<{ etag: string }>;

  /**
   * Initialize the registry storage backend.
   *
   * Creates the required storage resource if it does not exist (S3 bucket,
   * local file, DynamoDB table, etc.) and writes an empty `RegistryDocument`.
   *
   * @remarks
   * **Idempotent.** Safe to call multiple times — if the registry is already
   * initialized, this method is a no-op. Called automatically by
   * `slingshot infra init`.
   *
   * @throws {Error} If the storage backend cannot be created (e.g. insufficient
   *   IAM permissions for S3 bucket creation).
   */
  initialize(): Promise<void>;

  /**
   * Acquire a logical advisory lock on the registry.
   *
   * @remarks
   * **Advisory lock semantics.** The lock does not prevent concurrent reads or
   * writes at the storage level — it is a coordination primitive for the
   * `slingshot` CLI to serialize concurrent deploy/provision operations on the same
   * stack. The returned `RegistryLock.etag` should be passed to `write()` for
   * optimistic concurrency protection.
   *
   * Always call `lock.release()` in a `finally` block to avoid stale locks.
   * For `local` and `S3` providers, `release()` is a no-op.
   *
   * @param ttlMs - Optional lock TTL in milliseconds. When the lock is not
   *   explicitly released before this time, it expires automatically.
   *   Defaults vary by implementation.
   * @returns A `RegistryLock` with the current document's ETag and a `release()` method.
   *
   * @throws {Error} If the lock cannot be acquired within the implementation's
   *   timeout (e.g. DynamoDB conditional write fails after retries).
   */
  lock(ttlMs?: number): Promise<RegistryLock>;
}

/**
 * A logical registry lock returned by `RegistryProvider.lock()`.
 *
 * Provides the ETag to pass to `RegistryProvider.write()` for optimistic
 * concurrency. Call `release()` in a `finally` block.
 */
export interface RegistryLock {
  /**
   * ETag of the registry document at the moment the lock was acquired.
   *
   * Pass this to `RegistryProvider.write()` as the `etag` argument to ensure
   * no other process has written to the registry between lock acquisition and
   * the write call.
   */
  readonly etag: string;

  /**
   * Release the advisory lock.
   *
   * Must be called in a `finally` block to avoid leaving stale locks.
   * For `local` and `S3` providers this is a no-op; for providers backed by
   * a real lock store (e.g. DynamoDB conditional writes) it performs the
   * appropriate release operation.
   */
  release(): Promise<void>;
}

/**
 * Create an empty `RegistryDocument` for first-run initialization.
 *
 * @param platform - Platform identifier to embed in the document.
 * @returns A blank `RegistryDocument` with version `1` and empty collections.
 *
 * @example
 * ```ts
 * import { createEmptyRegistryDocument } from '@lastshotlabs/slingshot-infra';
 *
 * const doc = createEmptyRegistryDocument('acme');
 * await registry.write(doc);
 * ```
 */
export function createEmptyRegistryDocument(platform: string): RegistryDocument {
  return {
    version: 1,
    platform,
    updatedAt: new Date().toISOString(),
    stacks: {},
    resources: {},
    services: {},
  };
}

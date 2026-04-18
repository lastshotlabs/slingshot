import type { SharedResourceConfig } from './platform';

/**
 * Context object passed to `ResourceProvisioner.provision()` and `destroy()`.
 *
 * Provides all the data a provisioner needs to create or tear down AWS
 * resources for a specific resource/stage combination.
 */
export interface ResourceProvisionerContext {
  /**
   * Logical resource name as declared in `platform.resources`.
   * Used to derive unique cloud resource names (e.g. `'${platform}-${resourceName}-${stageName}'`).
   */
  resourceName: string;
  /**
   * Full resource config from `platform.resources[resourceName]`.
   * Contains type, size, and any provider-specific settings.
   */
  config: SharedResourceConfig;
  /**
   * Deployment stage this operation targets (e.g. `'production'`, `'staging'`).
   * Used alongside `resourceName` and `platform` for unique resource naming.
   */
  stageName: string;
  /**
   * AWS region where the resource should be provisioned or destroyed
   * (e.g. `'us-east-1'`).
   */
  region: string;
  /**
   * Platform/organization name from `DefinePlatformConfig.name`.
   * Prefixed to all cloud resource names to avoid collisions across platforms.
   */
  platform: string;
}

/**
 * A pluggable resource provisioner for a specific resource type.
 *
 * Follows the swappable-provider pattern: register via `createProvisionerRegistry()`
 * and retrieve by `resourceType`. Adding support for a new resource type means
 * implementing this interface and adding a case — no changes to existing code.
 */
export interface ResourceProvisioner {
  /**
   * Resource type identifier.
   *
   * @remarks
   * Must match the `type` field used in `DefinePlatformConfig.resources`.
   * Valid built-in values: `'postgres'`, `'redis'`, `'kafka'`, `'mongo'`, `'documentdb'`.
   * Custom provisioners may register additional types via `createProvisionerRegistry()`.
   */
  readonly resourceType: string;

  /**
   * Provision the resource for the given context and return connection outputs.
   *
   * @remarks
   * **Idempotent.** Safe to call when the resource already exists for the given
   * `ctx.stageName` — implementations must check for an existing resource before
   * creating a new one (e.g. using `describeDBInstances` with a `not found` check).
   * Called by `slingshot infra provision` and as a prerequisite step in `runDeployPipeline`.
   *
   * @param ctx - Context object with resource name, config, stage, region, and platform.
   * @returns A {@link ResourceOutput} with `status`, raw registry `outputs`, and
   *   `connectionEnv` vars to inject into consuming services.
   *
   * @throws {Error} If the cloud provider returns an unrecoverable error
   *   (access denied, quota exceeded, etc.). Transient errors should be retried
   *   by the caller.
   */
  provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput>;

  /**
   * Destroy the resource for the given context.
   *
   * @remarks
   * **Irreversible.** Permanently deletes the cloud resource (RDS instance,
   * ElastiCache cluster, etc.) and all associated data. The registry entry is
   * updated to `'failed'` status by the caller if this method throws.
   *
   * @param ctx - Context object with resource name, config, stage, region, and platform.
   *
   * @throws {Error} If the cloud provider returns an error. Partial teardown is
   *   possible — the caller should check the cloud console to verify cleanup.
   */
  destroy(ctx: ResourceProvisionerContext): Promise<void>;

  /**
   * Extract env vars from a prior provisioning output.
   *
   * @remarks
   * Translates the raw `outputs` stored in the registry into the named env vars
   * that consuming services need at runtime. For example, a Postgres provisioner
   * might build `DATABASE_URL` from `host`, `port`, `user`, `password`, and `db`
   * outputs. The returned map is merged into the resolved env for each service
   * that lists this resource in its `uses` array.
   *
   * @param outputs - The {@link ResourceOutput} returned by a previous `provision()` call.
   * @returns A flat `Record<string, string>` of env var name → value.
   *   Common keys by resource type (see also `RESOURCE_ENV_KEYS`):
   *   - `postgres`: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
   *   - `redis`: `REDIS_HOST`, `REDIS_USER`, `REDIS_PASSWORD`
   *   - `mongo`: `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_HOST`, `MONGO_DB`
   */
  getConnectionEnv(outputs: ResourceOutput): Record<string, string>;
}

/**
 * Output from `ResourceProvisioner.provision()`.
 *
 * `outputs` contains raw key-value pairs written to the registry.
 * `connectionEnv` contains the env vars injected into services that consume
 * this resource (e.g. `DATABASE_URL`, `REDIS_HOST`).
 */
export interface ResourceOutput {
  /**
   * Provisioning result status.
   * - `'provisioned'` — resource is ready; `outputs` and `connectionEnv` are populated.
   * - `'failed'` — provisioning failed; `outputs` should contain an `error` key with
   *   a human-readable message.
   */
  status: 'provisioned' | 'failed';
  /**
   * Raw key-value provisioning outputs written to the registry.
   * Contains connection primitives (host, port, credentials) as separate keys
   * so the registry stores structured data that can be re-processed if the
   * env var format changes in the future.
   */
  outputs: Record<string, string>;
  /**
   * Environment variables to inject into services that consume this resource.
   * Derived from `outputs` by `getConnectionEnv()`.
   * On failure (`status: 'failed'`), this should be an empty object `{}`.
   */
  connectionEnv: Record<string, string>;
}

/**
 * Env var keys produced by each resource type.
 *
 * Used by `resolveRequiredKeys()` to determine which secrets must be present
 * before deployment. Must match `frameworkSecretSchema` in slingshot-core.
 *
 * @example
 * ```ts
 * import { RESOURCE_ENV_KEYS } from '@lastshotlabs/slingshot-infra';
 *
 * const pgKeys = RESOURCE_ENV_KEYS['postgres'];
 * // ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']
 * ```
 */
export const RESOURCE_ENV_KEYS: Record<string, string[]> = {
  postgres: ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'],
  redis: ['REDIS_HOST', 'REDIS_USER', 'REDIS_PASSWORD'],
  kafka: ['KAFKA_BROKERS'],
  mongo: ['MONGO_USER', 'MONGO_PASSWORD', 'MONGO_HOST', 'MONGO_DB'],
  documentdb: [
    'DOCUMENTDB_URL',
    'DOCUMENTDB_HOST',
    'DOCUMENTDB_PORT',
    'DOCUMENTDB_USER',
    'DOCUMENTDB_PASSWORD',
    'DOCUMENTDB_DB',
  ],
};

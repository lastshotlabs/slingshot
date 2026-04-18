import type { RegistryConfig } from '../types/platform';
import type { RegistryProvider } from '../types/registry';
import { createLocalRegistry } from './localRegistry';
import { createPostgresRegistry } from './postgresRegistry';
import { createRedisRegistry } from './redisRegistry';
import { createS3Registry } from './s3Registry';

/**
 * Dispatch to the correct registry provider factory based on
 * `RegistryConfig.provider`.
 *
 * This is the primary factory used by the CLI and deploy pipeline to instantiate
 * whichever registry provider is declared in `slingshot.platform.ts`.
 *
 * @param config - The registry configuration from `DefinePlatformConfig.registry`.
 * @returns A `RegistryProvider` backed by S3, Redis, Postgres, or the local filesystem.
 *
 * @throws {Error} If required fields for the chosen provider are missing
 *   (e.g. S3 without `bucket`, Redis without `url`).
 *
 * @example
 * ```ts
 * import { createRegistryFromConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createRegistryFromConfig(platform.registry);
 * await registry.initialize();
 * ```
 */
export function createRegistryFromConfig(config: RegistryConfig): RegistryProvider {
  if (config.provider === 's3') {
    if (!config.bucket) {
      throw new Error('[slingshot-infra] S3 registry requires a "bucket" in registry config.');
    }
    return createS3Registry({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    });
  }
  if (config.provider === 'redis') {
    if (!config.url) {
      throw new Error('[slingshot-infra] Redis registry requires a "url" in registry config.');
    }
    return createRedisRegistry({ url: config.url, key: config.key });
  }
  if (config.provider === 'postgres') {
    if (!config.connectionString) {
      throw new Error(
        '[slingshot-infra] Postgres registry requires a "connectionString" in registry config.',
      );
    }
    return createPostgresRegistry({
      connectionString: config.connectionString,
      table: config.table,
    });
  }
  if (!config.path) {
    throw new Error('[slingshot-infra] Local registry requires a "path" in registry config.');
  }
  return createLocalRegistry({ path: config.path });
}

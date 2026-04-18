import type { DefinePlatformConfig } from '../types/platform';
import type { RegistryProvider } from '../types/registry';
import type { ResourceProvisionerContext } from '../types/resource';
import { createProvisionerRegistry } from './provisionerRegistry';
import { createDocumentDbProvisioner } from './provisioners/documentdb';
import { createKafkaProvisioner } from './provisioners/kafka';
import { createMongoProvisioner } from './provisioners/mongo';
import { createPostgresProvisioner } from './provisioners/postgres';
import { createRedisProvisioner } from './provisioners/redis';

/**
 * Parameters for `destroyResources()`.
 */
export interface DestroyResourcesParams {
  /** Platform config containing the resource definitions to destroy. */
  platform: DefinePlatformConfig;
  /** Deployment stage to target (e.g. `'production'`). */
  stageName: string;
  /** When specified, destroy only this resource. Default: all resources. */
  resource?: string;
  /** Registry provider used to read state and write the updated document. */
  registry: RegistryProvider;
  /** Optional provisioner registry override for deterministic tests. */
  provisioners?: {
    get(type: string): { destroy(ctx: ResourceProvisionerContext): Promise<void> };
  };
}

/**
 * Result for a single resource destruction operation.
 */
export interface DestroyResourceResult {
  /** Resource name as declared in `platform.resources`. */
  name: string;
  /** `'destroyed'` on success, `'skipped'` if not provisioned, `'error'` on failure. */
  status: 'destroyed' | 'skipped' | 'error';
  /** Human-readable reason for the `'skipped'` or `'error'` status. */
  message?: string;
}

/**
 * Destroy provisioned resources for a given stage.
 *
 * Guards against destroying a stage that still has deployed services — throws
 * if any service entry has `status: 'deployed'` for the target stage. For each
 * resource (or the one specified by `params.resource`), calls the matching
 * provisioner's `destroy()` method, removes the stage entry from the registry,
 * and writes the updated document back using an optimistic lock.
 *
 * @param params - Destruction parameters including platform config, stage, and
 *   optional resource filter.
 * @returns An array of per-resource results, one entry per resource processed.
 *
 * @throws {Error} If the registry is not initialized.
 * @throws {Error} If any service is still deployed on the target stage.
 * @throws {Error} If `params.resource` does not match any resource in
 *   `platform.resources`.
 *
 * @example
 * ```ts
 * import { destroyResources } from '@lastshotlabs/slingshot-infra';
 *
 * const results = await destroyResources({ platform, stageName: 'staging', registry });
 * for (const r of results) {
 *   console.log(r.name, r.status);
 * }
 * ```
 */
export async function destroyResources(
  params: DestroyResourcesParams,
): Promise<DestroyResourceResult[]> {
  const { platform, stageName, resource: targetResource, registry } = params;

  const registryDoc = await registry.read();
  if (!registryDoc) {
    throw new Error('Registry not initialized. Run: slingshot registry init');
  }

  // Guard: refuse if any service is deployed on this stage
  for (const [, serviceEntry] of Object.entries(registryDoc.services)) {
    const stageEntry = Object.prototype.hasOwnProperty.call(serviceEntry.stages, stageName)
      ? serviceEntry.stages[stageName]
      : undefined;
    if (stageEntry && stageEntry.status === 'deployed') {
      throw new Error(
        `Stage '${stageName}' has deployed services. Run 'slingshot rollback' or remove services first.`,
      );
    }
  }

  const provisioners =
    params.provisioners ??
    createProvisionerRegistry([
      createPostgresProvisioner(),
      createRedisProvisioner(),
      createKafkaProvisioner(),
      createMongoProvisioner(),
      createDocumentDbProvisioner(),
    ]);

  const resourceEntries = Object.entries(platform.resources ?? {}).filter(
    ([name]) => targetResource === undefined || name === targetResource,
  );

  if (targetResource !== undefined && resourceEntries.length === 0) {
    throw new Error(
      `Resource "${targetResource}" not found in platform config. ` +
        `Available: ${Object.keys(platform.resources ?? {}).join(', ')}`,
    );
  }

  const results: DestroyResourceResult[] = [];

  for (const [name, rc] of resourceEntries) {
    const resourceEntry = Object.prototype.hasOwnProperty.call(registryDoc.resources, name)
      ? registryDoc.resources[name]
      : undefined;
    const stageEntry =
      resourceEntry && Object.prototype.hasOwnProperty.call(resourceEntry.stages, stageName)
        ? resourceEntry.stages[stageName]
        : undefined;
    if (!stageEntry) {
      results.push({
        name,
        status: 'skipped',
        message: `Not provisioned for stage "${stageName}"`,
      });
      continue;
    }

    try {
      const provisioner = provisioners.get(rc.type);

      const ctx: ResourceProvisionerContext = {
        resourceName: name,
        config: rc,
        stageName,
        region: platform.region,
        platform: platform.org,
      };

      await provisioner.destroy(ctx);

      // Remove stage entry from registry
      if (resourceEntry) {
        resourceEntry.stages = Object.fromEntries(
          Object.entries(resourceEntry.stages).filter(([stage]) => stage !== stageName),
        );
      }

      results.push({ name, status: 'destroyed' });
    } catch (err) {
      results.push({
        name,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const lock = await registry.lock();
  try {
    await registry.write(registryDoc, lock.etag);
  } finally {
    await lock.release();
  }

  return results;
}

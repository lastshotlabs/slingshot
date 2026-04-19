import type {
  ResourceOutput,
  ResourceProvisioner,
  ResourceProvisionerContext,
} from '../../types/resource';
import {
  type ResourceProvisionEntry,
  generateResourceSstConfig,
  getResourceOutputKey,
} from '../generateResourceSst';
import { destroyViaSst, provisionViaSst } from '../provisionViaSst';

/**
 * Create a resource provisioner for Apache Kafka (AWS MSK via Pulumi/SST).
 *
 * When `config.provision` is `true`, generates an SST config with an
 * `aws.msk.Cluster` Pulumi resource and runs `bunx sst deploy`. The bootstrap
 * brokers string is parsed from SST stdout. When `provision` is `false`, the
 * `config.connection.brokers` value is returned as-is.
 *
 * @returns A `ResourceProvisioner` with `resourceType: 'kafka'`.
 *
 * @example
 * ```ts
 * import { createKafkaProvisioner } from '@lastshotlabs/slingshot-infra';
 *
 * const provisioner = createKafkaProvisioner();
 * const output = await provisioner.provision(ctx);
 * // output.connectionEnv contains KAFKA_BROKERS
 * ```
 */
export function createKafkaProvisioner(): ResourceProvisioner {
  return {
    resourceType: 'kafka',

    async provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput> {
      if (!ctx.config.provision) {
        const conn = ctx.config.connection ?? {};
        return {
          status: 'provisioned',
          outputs: conn,
          connectionEnv: {
            KAFKA_BROKERS: getConnectionValue(conn, 'brokers') ?? '',
          },
        };
      }

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'kafka.t3.small';
      const storageGb = stageOverride?.storageGb ?? 100;

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'kafka',
        instanceClass,
        storageGb,
        engineVersion: '3.5.1',
      };

      const sstConfig = generateResourceSstConfig([entry], {
        org: ctx.platform,
        region: ctx.region,
        stageName: ctx.stageName,
      });

      const result = await provisionViaSst({
        resourceName: ctx.resourceName,
        stageName: ctx.stageName,
        region: ctx.region,
        platform: ctx.platform,
        sstConfig,
      });

      if (!result.success) {
        return {
          status: 'failed',
          outputs: { error: result.error ?? 'Unknown provisioning error' },
          connectionEnv: {},
        };
      }

      const brokers = result.outputs[getResourceOutputKey(ctx.resourceName, 'Brokers')] ?? '';

      return {
        status: 'provisioned',
        outputs: {
          instanceClass,
          storageGb: String(storageGb),
          engine: 'kafka',
          engineVersion: '3.5.1',
          brokers,
        },
        connectionEnv: {
          KAFKA_BROKERS: brokers,
        },
      };
    },

    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      if (!ctx.config.provision) return;

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'kafka.t3.small';
      const storageGb = stageOverride?.storageGb ?? 100;

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'kafka',
        instanceClass,
        storageGb,
      };

      const sstConfig = generateResourceSstConfig([entry], {
        org: ctx.platform,
        region: ctx.region,
        stageName: ctx.stageName,
      });

      await destroyViaSst({
        resourceName: ctx.resourceName,
        stageName: ctx.stageName,
        region: ctx.region,
        sstConfig,
      });
    },

    getConnectionEnv(outputs: ResourceOutput): Record<string, string> {
      return outputs.connectionEnv;
    },
  };
}

function getConnectionValue(conn: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(conn, key) ? conn[key] : undefined;
}

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
 * Create a resource provisioner for Redis (ElastiCache Serverless via SST).
 *
 * When `config.provision` is `true`, generates an SST config with an
 * `sst.aws.Redis` component and runs `bunx sst deploy`. Outputs (host, port)
 * are parsed from SST stdout and stored in the registry. When `provision` is
 * `false`, the `config.connection` map is returned as-is.
 *
 * @returns A `ResourceProvisioner` with `resourceType: 'redis'`.
 *
 * @example
 * ```ts
 * import { createRedisProvisioner } from '@lastshotlabs/slingshot-infra';
 *
 * const provisioner = createRedisProvisioner();
 * const output = await provisioner.provision(ctx);
 * // output.connectionEnv contains REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 * ```
 */
export function createRedisProvisioner(): ResourceProvisioner {
  return {
    resourceType: 'redis',

    async provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput> {
      if (!ctx.config.provision) {
        const conn = ctx.config.connection ?? {};
        return {
          status: 'provisioned',
          outputs: conn,
          connectionEnv: buildConnectionEnv(conn),
        };
      }

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'cache.t3.micro';

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'redis',
        instanceClass,
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

      const outputs = result.outputs;

      const host = outputs[getResourceOutputKey(ctx.resourceName, 'Host')] ?? '';
      const port = outputs[getResourceOutputKey(ctx.resourceName, 'Port')] ?? '6379';

      const conn: Record<string, string> = {
        host,
        port,
        url: host ? `redis://${host}:${port}` : '',
      };

      return {
        status: 'provisioned',
        outputs: {
          instanceClass,
          engine: 'redis',
          engineVersion: '7',
          ...conn,
        },
        connectionEnv: buildConnectionEnv(conn),
      };
    },

    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      if (!ctx.config.provision) return;

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'cache.t3.micro';

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'redis',
        instanceClass,
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

/**
 * Build a set of standard Redis environment variables from a connection map.
 *
 * @param conn - Key/value map with any subset of `host`, `port`, `password`,
 *   and `url` fields. Missing fields default to safe empty strings (or `'6379'`
 *   for port).
 * @returns An environment variable record with the following keys:
 *   - `REDIS_URL` — full `redis://` connection string (uses `conn.url` if present,
 *     otherwise constructed from host and port; empty string when host is absent).
 *   - `REDIS_HOST` — Redis host.
 *   - `REDIS_PORT` — Redis port (defaults to `'6379'`).
 *   - `REDIS_PASSWORD` — Redis password (empty string if not set).
 *
 * @remarks
 * ElastiCache Serverless clusters do not use passwords by default; `REDIS_PASSWORD`
 * will be empty for SST-provisioned Redis. IAM authentication is handled at the
 * VPC/security-group level rather than via credentials in the connection string.
 */
function buildConnectionEnv(conn: Record<string, string>): Record<string, string> {
  const host = getConnectionValue(conn, 'host') ?? '';
  const port = getConnectionValue(conn, 'port') ?? '6379';
  const password = getConnectionValue(conn, 'password') ?? '';
  const url = getConnectionValue(conn, 'url') ?? (host ? `redis://${host}:${port}` : '');

  return {
    REDIS_URL: url,
    REDIS_HOST: host,
    REDIS_PORT: port,
    REDIS_PASSWORD: password,
  };
}

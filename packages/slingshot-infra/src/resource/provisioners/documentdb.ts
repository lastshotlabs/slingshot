import type {
  ResourceOutput,
  ResourceProvisioner,
  ResourceProvisionerContext,
} from '../../types/resource';
import { type ResourceProvisionEntry, generateResourceSstConfig } from '../generateResourceSst';
import { destroyViaSst, provisionViaSst } from '../provisionViaSst';

/**
 * Create a resource provisioner for Amazon DocumentDB (Mongo-compatible).
 *
 * When `config.provision` is `true`, generates an SST config with
 * `aws.docdb.Cluster` and `aws.docdb.ClusterInstance` Pulumi resources and
 * runs `bunx sst deploy`. Outputs (host, port, username, password, database)
 * are parsed from SST stdout. When `provision` is `false`, the
 * `config.connection` map is returned as-is.
 *
 * @returns A `ResourceProvisioner` with `resourceType: 'documentdb'`.
 *
 * @example
 * ```ts
 * import { createDocumentDbProvisioner } from '@lastshotlabs/slingshot-infra';
 *
 * const provisioner = createDocumentDbProvisioner();
 * const output = await provisioner.provision(ctx);
 * // output.connectionEnv contains DOCUMENTDB_URL, DOCUMENTDB_HOST, etc.
 * ```
 */
export function createDocumentDbProvisioner(): ResourceProvisioner {
  return {
    resourceType: 'documentdb',

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
      const instanceClass = stageOverride?.instanceClass ?? 'db.t3.medium';

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'documentdb',
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

      const name = ctx.resourceName.replace(/[^a-zA-Z0-9]/g, '');
      const outputs = result.outputs;

      const conn: Record<string, string> = {
        host: outputs[`${name}Host`] ?? '',
        port: outputs[`${name}Port`] ?? '27017',
        username: outputs[`${name}Username`] ?? 'admin',
        password: outputs[`${name}Password`] ?? '',
        database: outputs[`${name}Database`] ?? ctx.platform,
      };

      return {
        status: 'provisioned',
        outputs: {
          instanceClass,
          engine: 'documentdb',
          ...conn,
        },
        connectionEnv: buildConnectionEnv(conn),
      };
    },

    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      if (!ctx.config.provision) return;

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'db.t3.medium';

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'documentdb',
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
 * Build a set of standard DocumentDB environment variables from a connection map.
 *
 * @param conn - Key/value map with any subset of `host`, `port`, `username`
 *   (or `user`), `password`, `database`, and `url` fields. Missing fields
 *   default to safe empty strings (or `'27017'` for port).
 * @returns An environment variable record with the following keys:
 *   - `DOCUMENTDB_URL` — full `mongodb://` connection string with `tls=true` and
 *     `retryWrites=false` appended (required for DocumentDB TLS mode). Uses
 *     `conn.url` if present; otherwise constructed from individual fields.
 *     Empty string when host is absent.
 *   - `DOCUMENTDB_HOST` — DocumentDB cluster endpoint.
 *   - `DOCUMENTDB_PORT` — port (defaults to `'27017'`).
 *   - `DOCUMENTDB_USER` — master username.
 *   - `DOCUMENTDB_PASSWORD` — master password.
 *   - `DOCUMENTDB_DB` — database name.
 *
 * @remarks
 * DocumentDB requires `tls=true` and `retryWrites=false` in the connection
 * string. The `retryWrites=false` parameter is necessary because DocumentDB
 * does not support the MongoDB retryable writes specification.
 */
function buildConnectionEnv(conn: Record<string, string>): Record<string, string> {
  const host = getConnectionValue(conn, 'host') ?? '';
  const port = getConnectionValue(conn, 'port') ?? '27017';
  const user = getConnectionValue(conn, 'username') ?? getConnectionValue(conn, 'user') ?? '';
  const password = getConnectionValue(conn, 'password') ?? '';
  const database = getConnectionValue(conn, 'database') ?? '';
  const url =
    getConnectionValue(conn, 'url') ??
    (host
      ? `mongodb://${user}:${password}@${host}:${port}/${database}?tls=true&retryWrites=false`
      : '');

  return {
    DOCUMENTDB_URL: url,
    DOCUMENTDB_HOST: host,
    DOCUMENTDB_PORT: port,
    DOCUMENTDB_USER: user,
    DOCUMENTDB_PASSWORD: password,
    DOCUMENTDB_DB: database,
  };
}

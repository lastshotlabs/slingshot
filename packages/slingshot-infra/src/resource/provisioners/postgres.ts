import type {
  ResourceOutput,
  ResourceProvisioner,
  ResourceProvisionerContext,
} from '../../types/resource';
import { type ResourceProvisionEntry, generateResourceSstConfig } from '../generateResourceSst';
import { destroyViaSst, provisionViaSst } from '../provisionViaSst';

/**
 * Create a resource provisioner for PostgreSQL (Aurora Serverless v2).
 *
 * When `config.provision` is `true`, generates an SST config with an
 * `sst.aws.Postgres` component and runs `bunx sst deploy` in a temporary
 * directory. The outputs (host, port, user, password, database) are parsed
 * from SST stdout and stored in the registry. When `provision` is `false`,
 * the `config.connection` map is returned as-is.
 *
 * @returns A `ResourceProvisioner` with `resourceType: 'postgres'`.
 *
 * @example
 * ```ts
 * import { createPostgresProvisioner } from '@lastshotlabs/slingshot-infra';
 *
 * const provisioner = createPostgresProvisioner();
 * const output = await provisioner.provision(ctx);
 * // output.connectionEnv contains DATABASE_URL, PGHOST, PGPORT, etc.
 * ```
 */
export function createPostgresProvisioner(): ResourceProvisioner {
  return {
    resourceType: 'postgres',

    async provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput> {
      if (!ctx.config.provision) {
        const conn = ctx.config.connection ?? {};
        return {
          status: 'provisioned',
          outputs: conn,
          connectionEnv: buildConnectionEnv(conn),
        };
      }

      // Provision via SST — generates Aurora Serverless v2 (Postgres)
      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'db.t3.micro';
      const storageGb = stageOverride?.storageGb ?? 20;

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'postgres',
        instanceClass,
        storageGb,
        engineVersion: '16',
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
        port: outputs[`${name}Port`] ?? '5432',
        user: outputs[`${name}Username`] ?? 'postgres',
        password: outputs[`${name}Password`] ?? '',
        database: outputs[`${name}Database`] ?? ctx.platform,
      };

      return {
        status: 'provisioned',
        outputs: {
          instanceClass,
          storageGb: String(storageGb),
          engine: 'postgres',
          engineVersion: '16',
          ...conn,
        },
        connectionEnv: buildConnectionEnv(conn),
      };
    },

    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      if (!ctx.config.provision) return;

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceClass = stageOverride?.instanceClass ?? 'db.t3.micro';
      const storageGb = stageOverride?.storageGb ?? 20;

      const entry: ResourceProvisionEntry = {
        name: ctx.resourceName,
        type: 'postgres',
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

/**
 * Build a set of standard PostgreSQL environment variables from a connection map.
 *
 * @param conn - Key/value map with any subset of `host`, `port`, `user`,
 *   `password`, `database`, and `url` fields. Missing fields default to safe
 *   empty strings (or `'5432'` for port).
 * @returns An environment variable record with the following keys:
 *   - `DATABASE_URL` — full `postgres://` connection string (uses `conn.url` if present,
 *     otherwise constructed from individual fields; empty string when host is absent).
 *   - `PGHOST` — database host.
 *   - `PGPORT` — database port (defaults to `'5432'`).
 *   - `PGUSER` — database user.
 *   - `PGPASSWORD` — database password.
 *   - `PGDATABASE` — database name.
 *
 * @remarks
 * These variable names follow the `libpq` convention and are recognized by most
 * PostgreSQL clients (node-postgres, pg, drizzle, etc.) without additional config.
 */
function buildConnectionEnv(conn: Record<string, string>): Record<string, string> {
  const host = getConnectionValue(conn, 'host') ?? '';
  const port = getConnectionValue(conn, 'port') ?? '5432';
  const user = getConnectionValue(conn, 'user') ?? '';
  const password = getConnectionValue(conn, 'password') ?? '';
  const database = getConnectionValue(conn, 'database') ?? '';
  const url =
    getConnectionValue(conn, 'url') ??
    (host ? `postgres://${user}:${password}@${host}:${port}/${database}` : '');

  return {
    DATABASE_URL: url,
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
  };
}

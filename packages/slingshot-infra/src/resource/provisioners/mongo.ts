import type { SharedResourceConfig } from '../../types/platform';
import type {
  ResourceOutput,
  ResourceProvisioner,
  ResourceProvisionerContext,
} from '../../types/resource';
import { ATLAS_API_BASE, digestFetch, mapAwsRegionToAtlas } from '../atlasClient';

/**
 * Extended shared resource config for MongoDB Atlas provisioning.
 *
 * Extends the base `SharedResourceConfig` with Atlas-specific project and
 * organization identifiers. Credentials (`ATLAS_PUBLIC_KEY`,
 * `ATLAS_PRIVATE_KEY`) must be present in environment variables at provision
 * time.
 */
export interface MongoResourceConfig extends SharedResourceConfig {
  type: 'mongo';
  /** MongoDB Atlas project configuration */
  atlas?: {
    /** Atlas organization ID */
    orgId?: string;
    /** Atlas project ID */
    projectId?: string;
  };
}

const ATLAS_POLL_INTERVAL_MS = 10_000;
const ATLAS_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a resource provisioner for MongoDB Atlas.
 *
 * When `config.provision` is `true`, creates an Atlas cluster via the Atlas
 * Admin API (Digest auth), polls until the cluster reaches `IDLE`, creates a
 * database user, and builds the `mongodb+srv://` connection string. Polling
 * uses a 10-second interval with a 30-minute timeout.
 *
 * When `provision` is `false`, the `config.connection` map is returned as-is.
 *
 * @returns A `ResourceProvisioner` with `resourceType: 'mongo'`.
 *
 * @throws {Error} If `ATLAS_PUBLIC_KEY`, `ATLAS_PRIVATE_KEY`, `atlas.orgId`,
 *   or `atlas.projectId` are missing when `provision` is `true`.
 *
 * @example
 * ```ts
 * import { createMongoProvisioner } from '@lastshotlabs/slingshot-infra';
 *
 * const provisioner = createMongoProvisioner();
 * const output = await provisioner.provision(ctx);
 * // output.connectionEnv contains MONGO_URL, MONGO_HOST, MONGO_USER, etc.
 * ```
 */
export function createMongoProvisioner(): ResourceProvisioner {
  return {
    resourceType: 'mongo',

    async provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput> {
      if (!ctx.config.provision) {
        const conn = ctx.config.connection ?? {};
        return {
          status: 'provisioned',
          outputs: conn,
          connectionEnv: buildConnectionEnv(conn),
        };
      }

      const cfg = ctx.config as MongoResourceConfig;
      const atlasConfig = resolveAtlasConfig(cfg);

      const stageOverride = ctx.config.stages?.[ctx.stageName];
      const instanceSizeName = stageOverride?.instanceClass ?? 'M10';

      const clusterName = buildClusterName(ctx);
      const dbUsername = `${ctx.platform}-${ctx.stageName}`;
      const dbPassword = generatePassword();

      const clusterBody = JSON.stringify({
        name: clusterName,
        clusterType: 'REPLICASET',
        providerSettings: {
          providerName: 'AWS',
          regionName: mapAwsRegionToAtlas(ctx.region),
          instanceSizeName,
        },
        mongoDBMajorVersion: '7.0',
      });

      const createRes = await digestFetch(
        `${ATLAS_API_BASE}/groups/${atlasConfig.projectId}/clusters`,
        {
          method: 'POST',
          body: clusterBody,
          publicKey: atlasConfig.publicKey,
          privateKey: atlasConfig.privateKey,
        },
      );

      if (!createRes.ok) {
        const errText = await createRes.text();
        return {
          status: 'failed',
          outputs: { error: `Atlas cluster creation failed (${createRes.status}): ${errText}` },
          connectionEnv: {},
        };
      }

      const clusterData = await pollUntilIdle(
        atlasConfig,
        clusterName,
        ATLAS_POLL_INTERVAL_MS,
        ATLAS_POLL_TIMEOUT_MS,
      );

      const userBody = JSON.stringify({
        databaseName: 'admin',
        username: dbUsername,
        password: dbPassword,
        roles: [{ roleName: 'readWriteAnyDatabase', databaseName: 'admin' }],
      });

      const userRes = await digestFetch(
        `${ATLAS_API_BASE}/groups/${atlasConfig.projectId}/databaseUsers`,
        {
          method: 'POST',
          body: userBody,
          publicKey: atlasConfig.publicKey,
          privateKey: atlasConfig.privateKey,
        },
      );

      if (!userRes.ok) {
        const errText = await userRes.text();
        return {
          status: 'failed',
          outputs: {
            error: `Atlas database user creation failed (${userRes.status}): ${errText}`,
          },
          connectionEnv: {},
        };
      }

      const srvAddress = extractSrvAddress(clusterData);

      const conn: Record<string, string> = {
        host: srvAddress,
        username: dbUsername,
        password: dbPassword,
        database: ctx.platform,
      };

      return {
        status: 'provisioned',
        outputs: {
          engine: 'mongo',
          engineVersion: '7.0',
          instanceSizeName,
          clusterName,
          ...conn,
        },
        connectionEnv: buildConnectionEnv(conn),
      };
    },

    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      if (!ctx.config.provision) return;

      const cfg = ctx.config as MongoResourceConfig;
      const atlasConfig = resolveAtlasConfig(cfg);

      const clusterName = buildClusterName(ctx);
      const dbUsername = `${ctx.platform}-${ctx.stageName}`;

      const deleteRes = await digestFetch(
        `${ATLAS_API_BASE}/groups/${atlasConfig.projectId}/clusters/${clusterName}`,
        {
          method: 'DELETE',
          publicKey: atlasConfig.publicKey,
          privateKey: atlasConfig.privateKey,
        },
      );

      if (!deleteRes.ok && deleteRes.status !== 404) {
        const errText = await deleteRes.text();
        throw new Error(`Atlas cluster deletion failed (${deleteRes.status}): ${errText}`);
      }

      const deleteUserRes = await digestFetch(
        `${ATLAS_API_BASE}/groups/${atlasConfig.projectId}/databaseUsers/admin/${encodeURIComponent(dbUsername)}`,
        {
          method: 'DELETE',
          publicKey: atlasConfig.publicKey,
          privateKey: atlasConfig.privateKey,
        },
      );

      if (!deleteUserRes.ok && deleteUserRes.status !== 404) {
        const errText = await deleteUserRes.text();
        throw new Error(
          `Atlas database user deletion failed (${deleteUserRes.status}): ${errText}`,
        );
      }

      await pollUntilDeleted(
        atlasConfig,
        clusterName,
        ATLAS_POLL_INTERVAL_MS,
        ATLAS_POLL_TIMEOUT_MS,
      );
    },

    getConnectionEnv(outputs: ResourceOutput): Record<string, string> {
      return outputs.connectionEnv;
    },
  };
}

function getConnectionValue(conn: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(conn, key) ? conn[key] : undefined;
}

interface AtlasCredentials {
  publicKey: string;
  privateKey: string;
  orgId: string;
  projectId: string;
}

/**
 * Resolve Atlas credentials and project identifiers from environment and resource config.
 *
 * Reads `ATLAS_PUBLIC_KEY` and `ATLAS_PRIVATE_KEY` from `process.env`, and
 * `atlas.orgId` / `atlas.projectId` from the resource config.
 *
 * @param cfg - The `MongoResourceConfig` containing optional `atlas` identifiers.
 * @returns A fully-populated `AtlasCredentials` object.
 *
 * @throws {Error} If any of `ATLAS_PUBLIC_KEY`, `ATLAS_PRIVATE_KEY`,
 *   `atlas.orgId`, or `atlas.projectId` are missing or empty.
 */
function resolveAtlasConfig(cfg: MongoResourceConfig): AtlasCredentials {
  const publicKey = process.env.ATLAS_PUBLIC_KEY;
  const privateKey = process.env.ATLAS_PRIVATE_KEY;
  const orgId = cfg.atlas?.orgId;
  const projectId = cfg.atlas?.projectId;

  if (!publicKey || !privateKey || !orgId || !projectId) {
    throw new Error(
      'MongoDB Atlas provisioning requires ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY in secrets and atlas.orgId, atlas.projectId in resource config.',
    );
  }

  return { publicKey, privateKey, orgId, projectId };
}

/**
 * Build a deterministic Atlas cluster name from the provisioner context.
 *
 * Produces the pattern `<platform>-<stageName>-<resourceName>`. This name is
 * used both when creating the cluster and when polling or deleting it, so it
 * must be stable across provision/destroy calls for the same context.
 *
 * @param ctx - The `ResourceProvisionerContext` with `platform`, `stageName`, and `resourceName`.
 * @returns The Atlas cluster name string.
 *
 * @remarks
 * Atlas cluster names must be 1–64 characters, start with a letter, and contain
 * only letters, numbers, and hyphens. Ensure `platform`, `stageName`, and
 * `resourceName` values conform to these constraints before calling this function.
 */
function buildClusterName(ctx: ResourceProvisionerContext): string {
  return `${ctx.platform}-${ctx.stageName}-${ctx.resourceName}`;
}

/**
 * Generate a random 32-character alphanumeric password for the Atlas database user.
 *
 * @returns A 32-character string drawn from `[A-Za-z0-9]` (62 possible characters
 *   per position, ~190 bits of entropy).
 *
 * @remarks
 * Uses `Math.random()` rather than a cryptographically secure source. This is
 * acceptable because the password is stored immediately in the Atlas database user
 * record and in the registry outputs — it is never transmitted insecurely. If
 * stronger entropy is required, replace with `crypto.getRandomValues()`.
 *
 * The character set deliberately excludes special characters to avoid shell
 * escaping issues in the Atlas Admin API JSON body.
 */
function generatePassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < 32; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  return password;
}

/**
 * Extract the SRV hostname from an Atlas cluster API response.
 *
 * Reads `clusterData.connectionStrings.standardSrv` and strips the
 * `mongodb+srv://` scheme prefix, returning the bare hostname used as the
 * `MONGO_HOST` env var and as the host component of the connection string.
 *
 * @param clusterData - The parsed Atlas cluster object from the Admin API
 *   (the body of a `GET /groups/{projectId}/clusters/{clusterName}` response
 *   when `stateName` is `'IDLE'`).
 * @returns The SRV hostname without the `mongodb+srv://` prefix. Returns an
 *   empty string if `connectionStrings.standardSrv` is absent.
 *
 * @throws Never — missing fields fall back to an empty string.
 */
function extractSrvAddress(clusterData: Record<string, unknown>): string {
  const connStrings = clusterData.connectionStrings as Record<string, string> | undefined;
  const srv = connStrings?.standardSrv ?? '';
  return srv.replace(/^mongodb\+srv:\/\//, '');
}

/**
 * Poll the Atlas Admin API until a cluster reaches the `IDLE` state.
 *
 * Waits `intervalMs` before each poll attempt (sleeping first avoids
 * immediately querying a cluster that was just created). Resolves with the
 * full cluster API response object once `stateName === 'IDLE'`.
 *
 * @param credentials - Atlas credentials and project ID for the API requests.
 * @param clusterName - The Atlas cluster name to poll.
 * @param intervalMs - Milliseconds to wait between each poll attempt.
 * @param timeoutMs - Maximum total milliseconds to wait before giving up.
 * @returns The cluster API response object (parsed JSON) when the cluster is idle.
 *
 * @throws {Error} If the Atlas API returns a non-200 response during polling.
 * @throws {Error} If the cluster does not reach `IDLE` within `timeoutMs`.
 *
 * @remarks
 * The default values used by the provisioner are 10 seconds per interval and
 * 30 minutes total timeout, matching typical Atlas cluster creation durations.
 */
async function pollUntilIdle(
  credentials: AtlasCredentials,
  clusterName: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const res = await digestFetch(
      `${ATLAS_API_BASE}/groups/${credentials.projectId}/clusters/${clusterName}`,
      {
        method: 'GET',
        publicKey: credentials.publicKey,
        privateKey: credentials.privateKey,
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Atlas cluster poll failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data.stateName === 'IDLE') {
      return data;
    }
  }

  throw new Error(
    `Timed out waiting for Atlas cluster "${clusterName}" to become IDLE after ${timeoutMs / 1000}s`,
  );
}

/**
 * Poll the Atlas Admin API until a cluster is fully deleted.
 *
 * Waits `intervalMs` before each poll attempt. Resolves when the cluster
 * responds with HTTP 404 (cluster does not exist) or when its `stateName`
 * is `'DELETED'`.
 *
 * @param credentials - Atlas credentials and project ID for the API requests.
 * @param clusterName - The Atlas cluster name to poll.
 * @param intervalMs - Milliseconds to wait between each poll attempt.
 * @param timeoutMs - Maximum total milliseconds to wait before giving up.
 *
 * @throws {Error} If the Atlas API returns a non-404 error response during polling.
 * @throws {Error} If the cluster is not confirmed deleted within `timeoutMs`.
 *
 * @remarks
 * The default values used by the provisioner are 10 seconds per interval and
 * 30 minutes total timeout, matching typical Atlas cluster deletion durations.
 */
async function pollUntilDeleted(
  credentials: AtlasCredentials,
  clusterName: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const res = await digestFetch(
      `${ATLAS_API_BASE}/groups/${credentials.projectId}/clusters/${clusterName}`,
      {
        method: 'GET',
        publicKey: credentials.publicKey,
        privateKey: credentials.privateKey,
      },
    );

    if (res.status === 404) {
      return;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Atlas cluster poll failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data.stateName === 'DELETED') {
      return;
    }
  }

  throw new Error(
    `Timed out waiting for Atlas cluster "${clusterName}" to be deleted after ${timeoutMs / 1000}s`,
  );
}

/**
 * Return a promise that resolves after `ms` milliseconds.
 *
 * @param ms - Duration to wait in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a set of standard MongoDB environment variables from a connection map.
 *
 * @param conn - Key/value map with any subset of `host`, `username` (or `user`),
 *   `password`, `database`, and `url` fields. Missing fields default to safe
 *   empty strings.
 * @returns An environment variable record with the following keys:
 *   - `MONGO_URL` — full `mongodb+srv://` connection string. Uses `conn.url` if
 *     present; otherwise constructs from individual fields with `encodeURIComponent`
 *     applied to user and password. Empty string when host is absent.
 *   - `MONGO_HOST` — the SRV hostname (without scheme prefix).
 *   - `MONGO_USER` — database username.
 *   - `MONGO_PASSWORD` — database password.
 *   - `MONGO_DB` — database name.
 *
 * @remarks
 * Accepts both `conn.username` and `conn.user` for the username field;
 * `username` takes priority. This handles both Atlas-provisioned output
 * (which uses `username`) and manually-supplied connection maps.
 */
function buildConnectionEnv(conn: Record<string, string>): Record<string, string> {
  const host = getConnectionValue(conn, 'host') ?? '';
  const user = getConnectionValue(conn, 'username') ?? getConnectionValue(conn, 'user') ?? '';
  const password = getConnectionValue(conn, 'password') ?? '';
  const database = getConnectionValue(conn, 'database') ?? '';
  const url =
    getConnectionValue(conn, 'url') ??
    (host
      ? `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${database}`
      : '');

  return {
    MONGO_URL: url,
    MONGO_HOST: host,
    MONGO_USER: user,
    MONGO_PASSWORD: password,
    MONGO_DB: database,
  };
}

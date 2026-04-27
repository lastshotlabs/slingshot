import { getPostgresPoolRuntime, validateGrant } from '@lastshotlabs/slingshot-core';
import type {
  EvaluationScope,
  GrantEffect,
  PermissionGrant,
  SubjectRef,
  SubjectType,
  TestablePermissionsAdapter,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A scalar value type accepted as a parameterised query parameter by `pg`. */
export type PgParam = string | number | boolean | null | Date;

/** A row returned by a `pg` query, keyed by column name with scalar or string-array values. */
export type PgRow = Record<string, PgParam | string[]>;

/** Minimal query client used for migration transactions. */
export interface PoolClientLike {
  query(sql: string, params?: PgParam[]): Promise<{ rows: PgRow[]; rowCount: number | null }>;
  release(): void;
}

type Queryable = Pick<PoolClientLike, 'query'>;

/**
 * Minimal interface required from a `pg` Pool (or compatible test double).
 *
 * Defines the smallest surface area needed by `createPermissionsPostgresAdapter` so
 * that tests can pass a lightweight mock without depending on the full `pg` package.
 * A real `pg.Pool` instance satisfies this interface automatically.
 *
 * @remarks
 * The adapter uses `query()` for normal CRUD paths and `connect()` for the
 * migration transaction. Other `pg.Pool` methods are not required.
 */
export interface PoolLike {
  query(sql: string, params?: PgParam[]): Promise<{ rows: PgRow[]; rowCount: number | null }>;
  connect(): Promise<PoolClientLike>;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * A single schema migration function that accepts a queryable client and executes DDL
 * statements. Migrations run in version order inside `runMigrations`.
 *
 * @remarks
 * Never edit or reorder existing entries — append new migrations to the end of
 * `MIGRATIONS` only.
 */
type Migration = (db: Queryable) => Promise<void>;

/**
 * Ordered list of schema migrations for the permissions PostgreSQL adapter.
 *
 * - v1 (`MIGRATIONS[0]`): creates `permission_grants` with indexes on
 *   `(subject_id, subject_type)` and `(resource_type, resource_id)`.
 *
 * @remarks
 * Migrations are serialised with a PostgreSQL advisory transaction lock so
 * future data backfills and non-idempotent DDL remain safe under concurrent
 * startup.
 */
const MIGRATIONS: Migration[] = [
  // v1: initial schema
  async pool => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        tenant_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        roles JSONB NOT NULL DEFAULT '[]',
        effect TEXT NOT NULL DEFAULT 'allow',
        granted_by TEXT NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason TEXT,
        expires_at TIMESTAMPTZ,
        revoked_by TEXT,
        revoked_at TIMESTAMPTZ
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_subject ON permission_grants (subject_id, subject_type)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_resource ON permission_grants (resource_type, resource_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_tenant ON permission_grants (tenant_id)`,
    );
  },
  // v2: revocation audit field + composite lookup index
  async pool => {
    await pool.query(`ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS revoked_reason TEXT`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_permission_grants_subject_tenant ON permission_grants (subject_id, subject_type, tenant_id)`,
    );
  },
];

const MIGRATION_LOCK_KEY1 = 5412;
const MIGRATION_LOCK_KEY2 = 1947;

function parseVersion(raw: PgParam | string[] | undefined, maxVersion: number): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    if (raw > maxVersion) {
      throw new Error(
        `[slingshot-permissions] Database schema version ${raw} is newer than this binary supports (${maxVersion}).`,
      );
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      if (parsed > maxVersion) {
        throw new Error(
          `[slingshot-permissions] Database schema version ${parsed} is newer than this binary supports (${maxVersion}).`,
        );
      }
      return parsed;
    }
  }
  throw new Error(
    `[slingshot-permissions] Invalid value in _permission_schema_version: ${String(raw)}`,
  );
}

/**
 * Applies any pending permissions schema migrations against the given pool.
 *
 * Tracks the applied version in `_permission_schema_version`. Each migration
 * is executed sequentially and is immediately followed by a version bump inside
 * a single client transaction protected by a PostgreSQL advisory lock.
 *
 * @param pool - A `PoolLike` instance (real `pg.Pool` or compatible mock).
 * @returns A promise that resolves when all pending migrations have been applied.
 * @throws Re-throws any SQL error from a migration or the version tracking queries.
 *
 * @example
 * ```ts
 * // Called automatically inside createPermissionsPostgresAdapter — not needed
 * // in application code.
 * await runMigrations(pool);
 * ```
 */
async function runMigrations(pool: PoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      MIGRATION_LOCK_KEY1,
      MIGRATION_LOCK_KEY2,
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _permission_schema_version (
        version INTEGER NOT NULL DEFAULT 0
      )
    `);

    const versionResult = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS version FROM _permission_schema_version',
    );
    const currentVersion = parseVersion(versionResult.rows[0]?.version, MIGRATIONS.length);

    await client.query('DELETE FROM _permission_schema_version');
    await client.query('INSERT INTO _permission_schema_version (version) VALUES ($1)', [
      currentVersion,
    ]);
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_schema_version_singleton ON _permission_schema_version ((TRUE))',
    );

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      await MIGRATIONS[i](client);
      await client.query('UPDATE _permission_schema_version SET version = $1', [i + 1]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows a `PgParam | string[]` value to `SubjectType`.
 *
 * @param v - Raw column value from a `PgRow`.
 * @returns `true` if `v` is a valid `SubjectType` (`'user'`, `'group'`, or `'service-account'`),
 *   `false` for any other value.
 */
function isSubjectType(v: PgParam | string[]): v is SubjectType {
  return v === 'user' || v === 'group' || v === 'service-account';
}

/**
 * Type guard that narrows a `PgParam | string[]` value to `GrantEffect`.
 *
 * @param v - Raw column value from a `PgRow`.
 * @returns `true` if `v` is a valid `GrantEffect` (`'allow'` or `'deny'`),
 *   `false` for any other value.
 *
 * @remarks
 * Only two variants exist: `'allow'` (permit the action) and `'deny'` (explicitly
 * block the action). `'deny'` takes precedence over `'allow'` in the evaluation
 * logic. Any other string stored in the `effect` column is treated as invalid
 * and will cause `rowToGrant` to throw.
 */
function isGrantEffect(v: PgParam | string[]): v is GrantEffect {
  return v === 'allow' || v === 'deny';
}

/**
 * Asserts that a raw column value is a `string` and returns it.
 *
 * @param v - Raw column value from a `PgRow`.
 * @param field - Column name, used in the thrown error message for diagnostics.
 * @returns The value cast to `string`.
 * @throws {Error} If `v` is not a `string`.
 */
function str(v: PgParam | string[], field: string): string {
  if (typeof v === 'string') return v;
  throw new Error(`expected string for '${field}'`);
}

/**
 * Coerces a raw column value to `string | null`.
 *
 * @param v - Raw column value from a `PgRow`.
 * @returns The value as `string` or `null`.
 * @throws {Error} If `v` is neither `string` nor `null`.
 */
function strOrNull(v: PgParam | string[]): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  throw new Error(`expected string | null`);
}

/**
 * Coerces a raw column value to `Date | undefined`.
 *
 * `pg` returns `TIMESTAMPTZ` columns as `Date` objects; `NULL` columns as `null`.
 *
 * @param v - Raw column value from a `PgRow`.
 * @returns `undefined` when the column is `null`, or the `Date` value otherwise.
 * @throws {Error} If `v` is neither `null` nor a `Date`.
 */
function dateOrUndef(v: PgParam | string[]): Date | undefined {
  if (v === null) return undefined;
  if (v instanceof Date) return v;
  throw new Error(`expected Date | null`);
}

/**
 * Maps a raw `PgRow` from `permission_grants` to a typed `PermissionGrant` domain object.
 *
 * Validates `subject_type` and `effect` columns with type guards; asserts required string
 * columns; converts `granted_at` to a `Date`; deserialises the `roles` JSONB array.
 *
 * @param row - A raw row object from a `pg` query on `permission_grants`.
 * @returns The fully-typed `PermissionGrant`.
 * @throws {Error} If any column value has an unexpected type or an unknown enum variant.
 */
function rowToGrant(row: PgRow): PermissionGrant {
  const subjectType = row.subject_type;
  const effect = row.effect;
  if (!isSubjectType(subjectType)) throw new Error(`invalid subject_type: ${String(subjectType)}`);
  if (!isGrantEffect(effect)) throw new Error(`invalid effect: ${String(effect)}`);
  const roles = row.roles;
  if (!Array.isArray(roles)) throw new Error('roles must be an array');
  return {
    id: str(row.id, 'id'),
    subjectId: str(row.subject_id, 'subject_id'),
    subjectType,
    tenantId: strOrNull(row.tenant_id),
    resourceType: strOrNull(row.resource_type),
    resourceId: strOrNull(row.resource_id),
    roles,
    effect,
    grantedBy: str(row.granted_by, 'granted_by'),
    grantedAt:
      row.granted_at instanceof Date ? row.granted_at : new Date(str(row.granted_at, 'granted_at')),
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    expiresAt: dateOrUndef(row.expires_at),
    revokedBy: typeof row.revoked_by === 'string' ? row.revoked_by : undefined,
    revokedAt: dateOrUndef(row.revoked_at),
    revokedReason: typeof row.revoked_reason === 'string' ? row.revoked_reason : undefined,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Alias for `TestablePermissionsAdapter` returned by `createPermissionsPostgresAdapter`.
 * Exposes the `clear()` method for resetting state in integration tests.
 */
export type PermissionsPostgresAdapter = TestablePermissionsAdapter;

/**
 * Creates a PostgreSQL-backed `PermissionsAdapter`.
 *
 * Accepts any `PoolLike` (a `pg.Pool` or compatible mock). Schema migrations run automatically
 * using a separate `_permission_schema_version` table via a locked client transaction.
 * Roles are stored as JSONB.
 *
 * @param pool - A `pg.Pool` instance or compatible object with `query()` and `connect()`.
 * @returns A `PermissionsPostgresAdapter` instance, ready for use.
 *
 * @example
 * ```ts
 * import { createPermissionsPostgresAdapter } from '@lastshotlabs/slingshot-permissions';
 * import { connectPostgres } from '@lastshotlabs/slingshot-postgres';
 *
 * const { pool } = await connectPostgres(process.env.DATABASE_URL!);
 * const adapter = await createPermissionsPostgresAdapter(pool);
 * ```
 */
export async function createPermissionsPostgresAdapter(
  pool: PoolLike,
): Promise<PermissionsPostgresAdapter> {
  if (getPostgresPoolRuntime(pool as object)?.migrationMode !== 'assume-ready') {
    await runMigrations(pool);
  }

  return {
    async createGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string> {
      validateGrant(grant);
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO permission_grants
         (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          grant.subjectId,
          grant.subjectType,
          grant.tenantId,
          grant.resourceType,
          grant.resourceId,
          JSON.stringify(grant.roles),
          grant.effect,
          grant.grantedBy,
          grant.reason ?? null,
          grant.expiresAt ?? null,
        ],
      );
      return id;
    },

    async revokeGrant(
      grantId: string,
      revokedBy: string,
      tenantScope?: string,
      revokedReason?: string,
    ): Promise<boolean> {
      if (revokedReason !== undefined && revokedReason.length > 1024) {
        throw new Error('revokedReason exceeds maximum length of 1024');
      }
      const params: PgParam[] = [revokedBy, revokedReason ?? null, grantId];
      let sql = `UPDATE permission_grants SET revoked_by = $1, revoked_at = NOW(), revoked_reason = $2
         WHERE id = $3 AND revoked_at IS NULL`;
      if (tenantScope !== undefined) {
        sql += ` AND tenant_id = $4`;
        params.push(tenantScope);
      }
      const { rowCount } = await pool.query(sql, params);
      return (rowCount ?? 0) > 0;
    },

    async getGrantsForSubject(
      subjectId: string,
      subjectType?: SubjectType,
      scope?: Partial<Pick<PermissionGrant, 'tenantId' | 'resourceType' | 'resourceId'>>,
    ): Promise<PermissionGrant[]> {
      const conditions: string[] = [
        'subject_id = $1',
        'revoked_at IS NULL',
        '(expires_at IS NULL OR expires_at > NOW())',
      ];
      const params: PgParam[] = [subjectId];
      let idx = 2;

      if (subjectType !== undefined) {
        conditions.push(`subject_type = $${idx++}`);
        params.push(subjectType);
      }
      if (scope !== undefined) {
        if (scope.tenantId !== undefined) {
          conditions.push(`tenant_id = $${idx++}`);
          params.push(scope.tenantId);
        }
        if (scope.resourceType !== undefined) {
          conditions.push(`resource_type = $${idx++}`);
          params.push(scope.resourceType);
        }
        if (scope.resourceId !== undefined) {
          conditions.push(`resource_id = $${idx}`);
          params.push(scope.resourceId);
        }
      }

      const { rows } = await pool.query(
        `SELECT * FROM permission_grants WHERE ${conditions.join(' AND ')}`,
        params,
      );
      return rows.map(rowToGrant);
    },

    async listGrantHistory(
      subjectId: string,
      subjectType: SubjectType,
    ): Promise<PermissionGrant[]> {
      const { rows } = await pool.query(
        'SELECT * FROM permission_grants WHERE subject_id = $1 AND subject_type = $2',
        [subjectId, subjectType],
      );
      return rows.map(rowToGrant);
    },

    async getEffectiveGrantsForSubject(
      subjectId: string,
      subjectType: SubjectType,
      scope?: EvaluationScope,
    ): Promise<PermissionGrant[]> {
      const params: PgParam[] = [subjectId, subjectType];
      let idx = 3;
      const cascadeLevels: string[] = [
        '(tenant_id IS NULL AND resource_type IS NULL AND resource_id IS NULL)',
      ];

      const tenantId = scope?.tenantId;
      const resourceType = scope?.resourceType;
      const resourceId = scope?.resourceId;

      if (tenantId !== undefined) {
        params.push(tenantId);
        const tIdx = idx++;
        cascadeLevels.push(
          `(tenant_id = $${tIdx} AND resource_type IS NULL AND resource_id IS NULL)`,
        );
        if (resourceType !== undefined) {
          params.push(resourceType);
          const rtIdx = idx++;
          cascadeLevels.push(
            `(tenant_id = $${tIdx} AND resource_type = $${rtIdx} AND resource_id IS NULL)`,
          );
          if (resourceId !== undefined) {
            params.push(resourceId);
            const ridIdx = idx;
            cascadeLevels.push(
              `(tenant_id = $${tIdx} AND resource_type = $${rtIdx} AND resource_id = $${ridIdx})`,
            );
          }
        }
      }

      const { rows } = await pool.query(
        `SELECT * FROM permission_grants
         WHERE subject_id = $1 AND subject_type = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (${cascadeLevels.join(' OR ')})`,
        params,
      );
      return rows.map(rowToGrant);
    },

    async listGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
      limit?: number,
      offset?: number,
    ): Promise<PermissionGrant[]> {
      const conditions: string[] = [
        'resource_type = $1',
        'resource_id = $2',
        'revoked_at IS NULL',
        '(expires_at IS NULL OR expires_at > NOW())',
      ];
      const params: PgParam[] = [resourceType, resourceId];
      let idx = 3;

      if (tenantId !== undefined) {
        if (tenantId === null) {
          conditions.push('tenant_id IS NULL');
        } else {
          conditions.push(`tenant_id = $${idx++}`);
          params.push(tenantId);
        }
      }

      let sql = `SELECT * FROM permission_grants WHERE ${conditions.join(' AND ')}`;
      if (limit !== undefined) {
        sql += ` LIMIT $${idx++}`;
        params.push(limit);
      }
      if (offset !== undefined && offset > 0) {
        sql += ` OFFSET $${idx}`;
        params.push(offset);
      }

      const { rows } = await pool.query(sql, params);
      return rows.map(rowToGrant);
    },

    async createGrants(
      grantInputs: Omit<PermissionGrant, 'id' | 'grantedAt'>[],
    ): Promise<string[]> {
      for (const g of grantInputs) validateGrant(g);
      const client = await pool.connect();
      const ids: string[] = [];
      try {
        await client.query('BEGIN');
        for (const grant of grantInputs) {
          const id = crypto.randomUUID();
          await client.query(
            `INSERT INTO permission_grants
             (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              id,
              grant.subjectId,
              grant.subjectType,
              grant.tenantId,
              grant.resourceType,
              grant.resourceId,
              JSON.stringify(grant.roles),
              grant.effect,
              grant.grantedBy,
              grant.reason ?? null,
              grant.expiresAt ?? null,
            ],
          );
          ids.push(id);
        }
        await client.query('COMMIT');
        return ids;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async deleteAllGrantsForSubject(subject: SubjectRef): Promise<void> {
      await pool.query(
        'DELETE FROM permission_grants WHERE subject_id = $1 AND subject_type = $2',
        [subject.subjectId, subject.subjectType],
      );
    },

    async deleteAllGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
    ): Promise<void> {
      if (tenantId === undefined) {
        await pool.query(
          'DELETE FROM permission_grants WHERE resource_type = $1 AND resource_id = $2',
          [resourceType, resourceId],
        );
      } else if (tenantId === null) {
        await pool.query(
          'DELETE FROM permission_grants WHERE resource_type = $1 AND resource_id = $2 AND tenant_id IS NULL',
          [resourceType, resourceId],
        );
      } else {
        await pool.query(
          'DELETE FROM permission_grants WHERE resource_type = $1 AND resource_id = $2 AND tenant_id = $3',
          [resourceType, resourceId, tenantId],
        );
      }
    },

    async clear(): Promise<void> {
      await pool.query('TRUNCATE permission_grants CASCADE');
    },
  };
}

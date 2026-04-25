import { runSubsystemMigrations, validateGrant } from '@lastshotlabs/slingshot-core';
import type {
  EvaluationScope,
  GrantEffect,
  PermissionGrant,
  RuntimeSqliteDatabase,
  SubjectRef,
  SubjectType,
  TestablePermissionsAdapter,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * A single synchronous schema migration function that receives an open
 * `RuntimeSqliteDatabase` and executes DDL statements via `db.run()`.
 *
 * @remarks
 * Never edit or reorder existing entries — append new migrations to the end of
 * `MIGRATIONS` only.
 */
type Migration = (db: RuntimeSqliteDatabase) => void;

/**
 * Ordered list of schema migrations for the permissions SQLite adapter.
 *
 * - v1 (`MIGRATIONS[0]`): creates `permission_grants` with indexes on
 *   `subject_id`, `(subject_id, subject_type)`, and `(resource_type, resource_id)`.
 *   Timestamps are stored as INTEGER (Unix milliseconds). Roles are stored as
 *   JSON-encoded TEXT.
 *
 * @remarks
 * The applied version is tracked in the shared `_slingshot_migrations` table under
 * the `'permissions'` subsystem key via `runSubsystemMigrations`.
 */
const MIGRATIONS: Migration[] = [
  // v1: initial schema
  db => {
    db.run(`CREATE TABLE IF NOT EXISTS permission_grants (
      id             TEXT PRIMARY KEY,
      subject_id     TEXT NOT NULL,
      subject_type   TEXT NOT NULL,
      tenant_id      TEXT,
      resource_type  TEXT,
      resource_id    TEXT,
      roles          TEXT NOT NULL,
      effect         TEXT NOT NULL,
      granted_by     TEXT NOT NULL,
      granted_at     INTEGER NOT NULL,
      reason         TEXT,
      expires_at     INTEGER,
      revoked_by     TEXT,
      revoked_at     INTEGER
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_perm_subject ON permission_grants(subject_id)');
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_perm_subject_type ON permission_grants(subject_id, subject_type)',
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_perm_resource ON permission_grants(resource_type, resource_id)',
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_perm_tenant ON permission_grants(tenant_id)');
  },
  // v2: revocation audit field + composite lookup index
  db => {
    db.run('ALTER TABLE permission_grants ADD COLUMN revoked_reason TEXT');
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_perm_subject_tenant ON permission_grants(subject_id, subject_type, tenant_id)',
    );
  },
];

/**
 * Applies any pending permissions schema migrations to the SQLite database.
 *
 * Uses `runSubsystemMigrations` with the `'permissions'` subsystem key. Each
 * migration is executed in order and the subsystem version in `_slingshot_migrations`
 * is updated atomically after each step.
 *
 * @param db - An open `RuntimeSqliteDatabase` handle.
 *
 * @throws {SyntaxError} If any `roles` column in a previously-written row contains
 *   invalid JSON (corrupt data). Thrown inside `rowToGrant` when results are mapped;
 *   not thrown by `runMigrations` itself.
 *
 * @example
 * ```ts
 * // Called automatically inside createSqlitePermissionsAdapter — not needed
 * // in application code.
 * runMigrations(db);
 * ```
 */
function runMigrations(db: RuntimeSqliteDatabase): void {
  runSubsystemMigrations(db, 'permissions', MIGRATIONS);
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

/**
 * Raw SQLite row shape for the `permission_grants` table.
 *
 * Timestamps (`granted_at`, `expires_at`, `revoked_at`) are stored as INTEGER
 * (Unix milliseconds). `roles` is a JSON-encoded `string[]` stored as TEXT.
 * `subject_type` and `effect` are TEXT columns constrained to their respective
 * enum values at the application layer rather than via a SQLite CHECK constraint.
 *
 * @remarks
 * The `roles` field is stored as a JSON string (e.g. `'["admin","editor"]'`) in the
 * SQLite `TEXT` column. It is deserialized back to `string[]` by `rowToGrant` via
 * `JSON.parse`. Inserting non-JSON text into this column will cause a `SyntaxError`
 * at read time.
 */
interface GrantRow {
  id: string;
  subject_id: string;
  subject_type: SubjectType;
  tenant_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  /** JSON-encoded `string[]` — deserialised by `rowToGrant`. */
  roles: string;
  effect: GrantEffect;
  granted_by: string;
  /** Unix milliseconds — converted to `Date` by `rowToGrant`. */
  granted_at: number;
  reason: string | null;
  /** Unix milliseconds or `null` — converted to `Date | undefined` by `rowToGrant`. */
  expires_at: number | null;
  revoked_by: string | null;
  /** Unix milliseconds or `null` — converted to `Date | undefined` by `rowToGrant`. */
  revoked_at: number | null;
  revoked_reason: string | null;
}

function resolveSync<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

function parseRoles(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('roles must be a JSON-encoded string array');
  }
  if (!parsed.every((role): role is string => typeof role === 'string')) {
    throw new Error('roles must be a JSON-encoded string array');
  }
  return [...parsed];
}

/**
 * Maps a raw `GrantRow` SQLite result to a typed `PermissionGrant` domain object.
 *
 * Deserialises the JSON `roles` column, converts Unix-millisecond timestamps to
 * `Date` instances, and maps `null` timestamp columns to `undefined`.
 *
 * @param row - A raw row queried from the `permission_grants` table.
 * @returns The fully-typed `PermissionGrant` domain object.
 * @throws {SyntaxError} If the `roles` column contains invalid JSON.
 */
function rowToGrant(row: GrantRow): PermissionGrant {
  const roles = parseRoles(row.roles);
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
    tenantId: row.tenant_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    roles,
    effect: row.effect,
    grantedBy: row.granted_by,
    grantedAt: new Date(row.granted_at),
    reason: row.reason ?? undefined,
    expiresAt: row.expires_at !== null ? new Date(row.expires_at) : undefined,
    revokedBy: row.revoked_by ?? undefined,
    revokedAt: row.revoked_at !== null ? new Date(row.revoked_at) : undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Alias for `TestablePermissionsAdapter` returned by `createSqlitePermissionsAdapter`.
 * Exposes the `clear()` method for resetting state between tests.
 */
export type PermissionsSqliteAdapter = TestablePermissionsAdapter;

/** @deprecated Use createSqlitePermissionsAdapter — schema init is handled internally. */
export function initPermissionsSchema(db: RuntimeSqliteDatabase): void {
  runMigrations(db);
}

/**
 * Creates a SQLite-backed `PermissionsAdapter` using a `RuntimeSqliteDatabase`.
 *
 * Schema migrations run automatically on first call. WAL mode and foreign-key enforcement
 * are enabled. Roles are stored as JSON text in a single column.
 *
 * @param db - An open `RuntimeSqliteDatabase` handle (from `SlingshotRuntime.sqlite.open`).
 * @returns A `PermissionsSqliteAdapter` instance with a `clear()` method for test teardown.
 *
 * @example
 * ```ts
 * import { createSqlitePermissionsAdapter } from '@lastshotlabs/slingshot-permissions';
 *
 * const adapter = createSqlitePermissionsAdapter(runtime.sqlite.open('./permissions.db'));
 * ```
 */
export function createSqlitePermissionsAdapter(
  db: RuntimeSqliteDatabase,
): PermissionsSqliteAdapter {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db);

  return {
    createGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string> {
      return resolveSync(() => {
        validateGrant(grant);
        const id = crypto.randomUUID();
        const now = Date.now();
        db.run(
          `INSERT INTO permission_grants
           (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, reason, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          grant.subjectId,
          grant.subjectType,
          grant.tenantId,
          grant.resourceType,
          grant.resourceId,
          JSON.stringify(grant.roles),
          grant.effect,
          grant.grantedBy,
          now,
          grant.reason ?? null,
          grant.expiresAt ? grant.expiresAt.getTime() : null,
        );
        return id;
      });
    },

    revokeGrant(
      grantId: string,
      revokedBy: string,
      tenantScope?: string,
      revokedReason?: string,
    ): Promise<boolean> {
      return resolveSync(() => {
        if (revokedReason !== undefined && revokedReason.length > 1024) {
          throw new Error('revokedReason exceeds maximum length of 1024');
        }
        const existing = db
          .query<GrantRow>('SELECT * FROM permission_grants WHERE id = ?')
          .get(grantId);
        if (!existing || existing.revoked_at !== null) return false;
        if (tenantScope !== undefined && existing.tenant_id !== tenantScope) return false;
        db.run(
          'UPDATE permission_grants SET revoked_by = ?, revoked_at = ?, revoked_reason = ? WHERE id = ?',
          revokedBy,
          Date.now(),
          revokedReason ?? null,
          grantId,
        );
        return true;
      });
    },

    getGrantsForSubject(
      subjectId: string,
      subjectType?: SubjectType,
      scope?: Partial<Pick<PermissionGrant, 'tenantId' | 'resourceType' | 'resourceId'>>,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const conditions: string[] = [
          'subject_id = ?',
          'revoked_at IS NULL',
          '(expires_at IS NULL OR expires_at > ?)',
        ];
        const params: unknown[] = [subjectId, Date.now()];

        if (subjectType !== undefined) {
          conditions.push('subject_type = ?');
          params.push(subjectType);
        }
        if (scope !== undefined) {
          if (scope.tenantId !== undefined) {
            conditions.push('tenant_id = ?');
            params.push(scope.tenantId);
          }
          if (scope.resourceType !== undefined) {
            conditions.push('resource_type = ?');
            params.push(scope.resourceType);
          }
          if (scope.resourceId !== undefined) {
            conditions.push('resource_id = ?');
            params.push(scope.resourceId);
          }
        }

        const where = conditions.join(' AND ');
        const rows = db
          .query<GrantRow>(`SELECT * FROM permission_grants WHERE ${where}`)
          .all(...params);
        return rows.map(rowToGrant);
      });
    },

    listGrantHistory(subjectId: string, subjectType: SubjectType): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const rows = db
          .query<GrantRow>(
            'SELECT * FROM permission_grants WHERE subject_id = ? AND subject_type = ?',
          )
          .all(subjectId, subjectType);
        return rows.map(rowToGrant);
      });
    },

    getEffectiveGrantsForSubject(
      subjectId: string,
      subjectType: SubjectType,
      scope?: EvaluationScope,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const params: unknown[] = [subjectId, subjectType, Date.now()];
        const cascadeLevels: string[] = [
          '(tenant_id IS NULL AND resource_type IS NULL AND resource_id IS NULL)',
        ];

        const tenantId = scope?.tenantId;
        const resourceType = scope?.resourceType;
        const resourceId = scope?.resourceId;

        if (tenantId !== undefined) {
          cascadeLevels.push('(tenant_id = ? AND resource_type IS NULL AND resource_id IS NULL)');
          params.push(tenantId);
          if (resourceType !== undefined) {
            cascadeLevels.push('(tenant_id = ? AND resource_type = ? AND resource_id IS NULL)');
            params.push(tenantId, resourceType);
            if (resourceId !== undefined) {
              cascadeLevels.push('(tenant_id = ? AND resource_type = ? AND resource_id = ?)');
              params.push(tenantId, resourceType, resourceId);
            }
          }
        }

        const where = `subject_id = ? AND subject_type = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND (${cascadeLevels.join(' OR ')})`;
        const rows = db
          .query<GrantRow>(`SELECT * FROM permission_grants WHERE ${where}`)
          .all(...params);
        return rows.map(rowToGrant);
      });
    },

    listGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
      limit?: number,
      offset?: number,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const conditions: string[] = [
          'resource_type = ?',
          'resource_id = ?',
          'revoked_at IS NULL',
          '(expires_at IS NULL OR expires_at > ?)',
        ];
        const params: unknown[] = [resourceType, resourceId, Date.now()];

        if (tenantId !== undefined) {
          if (tenantId === null) {
            conditions.push('tenant_id IS NULL');
          } else {
            conditions.push('tenant_id = ?');
            params.push(tenantId);
          }
        }

        let sql = `SELECT * FROM permission_grants WHERE ${conditions.join(' AND ')}`;
        // SQLite requires LIMIT before OFFSET; use LIMIT -1 when only offset is given.
        if (limit !== undefined || (offset !== undefined && offset > 0)) {
          sql += ' LIMIT ?';
          params.push(limit ?? -1);
        }
        if (offset !== undefined && offset > 0) {
          sql += ' OFFSET ?';
          params.push(offset);
        }

        const rows = db.query<GrantRow>(sql).all(...params);
        return rows.map(rowToGrant);
      });
    },

    createGrants(grantInputs: Omit<PermissionGrant, 'id' | 'grantedAt'>[]): Promise<string[]> {
      return resolveSync(() => {
        for (const g of grantInputs) validateGrant(g);
        const ids: string[] = grantInputs.map(() => crypto.randomUUID());
        const now = Date.now();
        const insertAll = db.transaction(() => {
          for (let i = 0; i < grantInputs.length; i++) {
            const grant = grantInputs[i];
            db.run(
              `INSERT INTO permission_grants
               (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, reason, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ids[i],
              grant.subjectId,
              grant.subjectType,
              grant.tenantId,
              grant.resourceType,
              grant.resourceId,
              JSON.stringify(grant.roles),
              grant.effect,
              grant.grantedBy,
              now,
              grant.reason ?? null,
              grant.expiresAt ? grant.expiresAt.getTime() : null,
            );
          }
        });
        insertAll();
        return ids;
      });
    },

    deleteAllGrantsForSubject(subject: SubjectRef): Promise<void> {
      return resolveSync(() => {
        db.run(
          'DELETE FROM permission_grants WHERE subject_id = ? AND subject_type = ?',
          subject.subjectId,
          subject.subjectType,
        );
      });
    },

    deleteAllGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
    ): Promise<void> {
      return resolveSync(() => {
        let sql = 'DELETE FROM permission_grants WHERE resource_type = ? AND resource_id = ?';
        const params: unknown[] = [resourceType, resourceId];
        if (tenantId !== undefined) {
          if (tenantId === null) {
            sql += ' AND tenant_id IS NULL';
          } else {
            sql += ' AND tenant_id = ?';
            params.push(tenantId);
          }
        }
        db.run(sql, ...params);
      });
    },

    clear(): Promise<void> {
      return resolveSync(() => {
        db.run('DELETE FROM permission_grants');
      });
    },
  };
}

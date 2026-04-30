import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient } from 'pg';
import { HttpError, getPostgresPoolRuntime } from '@lastshotlabs/slingshot-core';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import {
  groupMemberships,
  groups,
  oauthAccounts,
  recoveryCodes,
  tenantRoles,
  userRoles,
  users,
  webauthnCredentials,
} from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Internal cursor payload encoded in opaque pagination cursors.
 * Carries both the `createdAt` ISO string and the record `id` so that the
 * `(createdAt, id)` compound index can be used for stable keyset pagination.
 *
 * @remarks
 * Cursors are transmitted as base64-encoded JSON strings. The JSON object is
 * stringified, then passed through `btoa()` to produce the opaque cursor that
 * clients receive. `decodeCursor` reverses this with `atob()` + `JSON.parse`.
 */
interface CursorPayload {
  /** ISO 8601 timestamp of the row that was the last item on the previous page. */
  createdAt: string;
  /** Primary key of the row that was the last item on the previous page. */
  id: string;
}

/**
 * Encodes a `(createdAt, id)` pair into an opaque base64 cursor string.
 *
 * @param createdAt - The `createdAt` timestamp of the last item on the current page.
 * @param id - The primary key of the last item on the current page.
 * @returns An opaque base64-encoded cursor string safe to pass to the next page request.
 *
 * @remarks
 * The `Date` value is serialized to an ISO 8601 string via `Date.prototype.toISOString()`
 * before being JSON-stringified. This ensures timezone-neutral, lossless representation
 * when the cursor is decoded and used in subsequent `WHERE createdAt > ?` comparisons.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return btoa(JSON.stringify({ createdAt: createdAt.toISOString(), id }));
}

/**
 * Decodes an opaque cursor string back into a `CursorPayload`.
 *
 * @param cursor - The cursor string previously produced by `encodeCursor`.
 * @returns The decoded `CursorPayload`, or `null` if the cursor is malformed or tampered.
 *
 * @remarks
 * Returns `null` rather than throwing so callers can treat an invalid cursor as
 * a missing cursor (i.e. start from the first page).
 */
function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(atob(cursor)) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the supplied error is a PostgreSQL unique-constraint violation.
 *
 * PostgreSQL error code `23505` is raised by `INSERT` and `UPDATE` statements that
 * violate a `UNIQUE` index. Used to translate database errors into typed `HttpError`
 * responses without depending on `pg`'s typed error classes.
 *
 * @param err - The unknown error thrown by a `pg` or Drizzle query.
 * @returns `true` if the error (or its `.cause`) has `code === '23505'`, `false` otherwise.
 *
 * @remarks
 * The `code` property must be exactly the string `'23505'` — `pg` surfaces PostgreSQL
 * SQLSTATE codes as string properties on thrown error objects. Drizzle wraps `pg` errors
 * in a `DrizzleQueryError` with the original error in the `.cause` property — both
 * levels are checked. Other unique-violation adjacent codes (e.g. `'23514'` for check
 * violations) do not match and return `false`.
 */
export function hasCode23505(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

export function isUniqueViolation(err: unknown): boolean {
  if (hasCode23505(err)) return true;
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return hasCode23505((err as { cause: unknown }).cause);
  }
  return false;
}

function firstRowOrNull<T>(rows: T[]): T | null {
  const [row] = rows;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * A single schema migration function that receives an active `PoolClient`
 * inside an open transaction. Each migration is run exactly once, in order,
 * and is recorded in `_slingshot_auth_schema_version` atomically in the same
 * transaction.
 *
 * @remarks
 * Never edit or reorder existing entries — append new migrations to the end of
 * `MIGRATIONS` only.
 */
type Migration = (client: PoolClient) => Promise<void>;

/**
 * Ordered list of schema migrations for the slingshot-postgres auth adapter.
 *
 * - v1 (`MIGRATIONS[0]`): creates `slingshot_users`, `slingshot_oauth_accounts`,
 *   `slingshot_user_roles`, and `slingshot_tenant_roles`.
 * - v2 (`MIGRATIONS[1]`): adds MFA columns + `slingshot_recovery_codes`,
 *   `slingshot_webauthn_credentials`, `slingshot_groups`, and
 *   `slingshot_group_memberships`.
 *
 * @remarks
 * Each migration runs inside the same transaction as the version-bump UPDATE so
 * a mid-migration crash leaves the schema unchanged and is automatically retried
 * on the next startup.
 */
const MIGRATIONS: Migration[] = [
  // v1: core auth tables
  async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        suspended BOOLEAN NOT NULL DEFAULT FALSE,
        suspended_reason TEXT,
        suspended_at TIMESTAMPTZ,
        display_name TEXT,
        first_name TEXT,
        last_name TEXT,
        external_id TEXT,
        user_metadata JSONB,
        app_metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_oauth_accounts (
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, provider_user_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_user_roles (
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        PRIMARY KEY (user_id, role)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_tenant_roles (
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (user_id, tenant_id, role)
      )
    `);
  },
  // v2: MFA, WebAuthn, and Groups
  async client => {
    // MFA columns on users
    await client.query(`ALTER TABLE slingshot_users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`);
    await client.query(
      `ALTER TABLE slingshot_users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    await client.query(
      `ALTER TABLE slingshot_users ADD COLUMN IF NOT EXISTS mfa_methods TEXT[] NOT NULL DEFAULT '{}'`,
    );
    // Recovery codes — separate table for atomic single-query consume
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_recovery_codes (
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        PRIMARY KEY (user_id, code_hash)
      )
    `);
    // WebAuthn credentials
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        transports TEXT[],
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_slingshot_webauthn_user_id ON slingshot_webauthn_credentials(user_id)`,
    );
    // Groups — partial unique indexes enforce name uniqueness within scope
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        roles TEXT[] NOT NULL DEFAULT '{}',
        tenant_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_slingshot_groups_name_appwide ON slingshot_groups(name) WHERE tenant_id IS NULL`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_slingshot_groups_name_tenant ON slingshot_groups(name, tenant_id) WHERE tenant_id IS NOT NULL`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_slingshot_groups_tenant ON slingshot_groups(tenant_id)`,
    );
    // Group memberships
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_group_memberships (
        user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES slingshot_groups(id) ON DELETE CASCADE,
        roles TEXT[] NOT NULL DEFAULT '{}',
        tenant_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, group_id)
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_slingshot_gm_group_id ON slingshot_group_memberships(group_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_slingshot_gm_user_tenant ON slingshot_group_memberships(user_id, tenant_id)`,
    );
  },
  // Add future migrations here. Never edit or reorder existing entries.
];

/**
 * First of two arbitrary but stable integer IDs used with `pg_advisory_xact_lock(int, int)`.
 *
 * PostgreSQL advisory transaction locks are released automatically when the
 * enclosing transaction ends, eliminating the need for explicit unlock calls.
 * The `(MIGRATION_LOCK_KEY1, MIGRATION_LOCK_KEY2)` pair must be globally unique
 * across all advisory locks acquired by this application.
 */
const MIGRATION_LOCK_KEY1 = 7283;

/**
 * Second of two arbitrary but stable integer IDs used with `pg_advisory_xact_lock(int, int)`.
 * See `MIGRATION_LOCK_KEY1` for full rationale.
 */
const MIGRATION_LOCK_KEY2 = 4829;

/**
 * Parse and validate the migration version stored in the Postgres metadata table.
 *
 * Accepts numeric values and numeric strings returned by different Postgres clients,
 * rejects malformed or negative versions, and fails fast when the database schema is
 * newer than the migrations bundled with the current package version.
 *
 * @param raw - The raw version value read from the migration metadata row.
 * @param maxVersion - The highest migration version supported by this package.
 * @returns The validated integer migration version.
 */
export function parseMigrationVersion(raw: unknown, maxVersion: number): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    if (raw > maxVersion) {
      throw new Error(
        `[slingshot-postgres] Database schema version ${raw} is newer than this binary supports (${maxVersion}).`,
      );
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      if (parsed > maxVersion) {
        throw new Error(
          `[slingshot-postgres] Database schema version ${parsed} is newer than this binary supports (${maxVersion}).`,
        );
      }
      return parsed;
    }
  }
  throw new Error(
    `[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: ${String(raw)}`,
  );
}

/**
 * Applies any pending schema migrations to the database in a single serialised transaction.
 *
 * Acquires a PostgreSQL advisory transaction lock using `pg_advisory_xact_lock` so that
 * concurrent server processes cannot race during migrations (e.g. on cluster startup).
 * The lock is released automatically when the transaction commits or rolls back.
 *
 * Tracks applied migrations in `_slingshot_auth_schema_version`. The runner first
 * canonicalizes that table to a single row holding the highest observed version,
 * then applies any missing migrations and bumps the version in the same locked
 * transaction. If any migration throws, the entire transaction is rolled back and
 * the error is re-thrown.
 *
 * @param pool - An open `pg.Pool` used to acquire a client for the migration transaction.
 * @returns A promise that resolves when all pending migrations have been applied.
 * @throws Re-throws any error from a migration function or from `pg` itself after rollback.
 *
 * @example
 * ```ts
 * // Called automatically inside createPostgresAdapter — not needed in application code.
 * await runMigrations(pool);
 * ```
 */
async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock is released automatically when the transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      MIGRATION_LOCK_KEY1,
      MIGRATION_LOCK_KEY2,
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _slingshot_auth_schema_version (
        version INTEGER NOT NULL DEFAULT 0
      )
    `);
    const result = await client.query<{ version: number | string }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM _slingshot_auth_schema_version',
    );
    const currentVersion = parseMigrationVersion(result.rows[0]?.version, MIGRATIONS.length);
    await client.query('DELETE FROM _slingshot_auth_schema_version');
    await client.query('INSERT INTO _slingshot_auth_schema_version (version) VALUES ($1)', [
      currentVersion,
    ]);
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_slingshot_auth_schema_version_singleton ON _slingshot_auth_schema_version ((TRUE))',
    );
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      await MIGRATIONS[i](client);
      await client.query('UPDATE _slingshot_auth_schema_version SET version = $1', [i + 1]);
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Options accepted by `createPostgresAdapter`.
 */
export interface PostgresAdapterOptions {
  /** An open, verified `pg.Pool` (e.g. from `connectPostgres(...).pool`). */
  pool: Pool;
  /**
   * Password verification function.
   *
   * When provided, the adapter uses this to verify passwords instead of the
   * `Bun.password` built-in. Required for Node.js deployments — pass the
   * `verify` function from your runtime of choice (e.g. `runtime-node`'s
   * argon2 verifier, or `runtime-edge`'s PBKDF2 verifier).
   *
   * When omitted and running under Bun, `Bun.password.verify` is used
   * automatically. When omitted under Node.js, password verification throws
   * a descriptive error.
   */
  verifyPassword?: (plain: string, hash: string) => Promise<boolean>;
}

/**
 * Creates a PostgreSQL-backed `AuthAdapter` for slingshot-auth.
 *
 * Schema migrations run automatically on first call using a per-migration transaction
 * with a `_slingshot_schema_version` guard table. The adapter implements the full
 * `AuthAdapter` interface: users, groups, memberships, roles, OAuth accounts,
 * WebAuthn credentials, recovery codes, and tenant roles.
 *
 * @param opts - Options containing an open `pg.Pool`.
 * @returns A fully-initialised `AuthAdapter` ready to pass to the auth plugin config.
 *
 * @example
 * ```ts
 * import { createPostgresAdapter } from '@lastshotlabs/slingshot-postgres';
 * import { connectPostgres } from '@lastshotlabs/slingshot-postgres';
 *
 * const { pool, db } = await connectPostgres(process.env.DATABASE_URL!);
 * const authAdapter = await createPostgresAdapter({ pool });
 * ```
 */
export async function createPostgresAdapter(opts: PostgresAdapterOptions): Promise<AuthAdapter> {
  if (getPostgresPoolRuntime(opts.pool)?.migrationMode !== 'assume-ready') {
    await runMigrations(opts.pool);
  }
  const db = drizzle(opts.pool);

  return {
    // ── Tier 1 — CoreAuthAdapter ──────────────────────────────────────────────

    async findByEmail(email) {
      const row = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .then(firstRowOrNull);
      if (!row) return null;
      return { id: row.id, passwordHash: row.passwordHash ?? '' };
    },

    async create(email, passwordHash) {
      const id = crypto.randomUUID();
      try {
        await db.insert(users).values({
          id,
          email: email.toLowerCase(),
          passwordHash,
          emailVerified: false,
          suspended: false,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, 'Email already registered');
        }
        throw err;
      }
      return { id };
    },

    async verifyPassword(userId, password) {
      const row = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      if (!row?.passwordHash) return false;
      if (opts.verifyPassword) {
        return opts.verifyPassword(password, row.passwordHash);
      }
      if (typeof Bun !== 'undefined' && Bun.password?.verify) {
        return Bun.password.verify(password, row.passwordHash);
      }
      throw new Error(
        '[slingshot-postgres] No password verifier available. Pass `verifyPassword` to ' +
          '`createPostgresAdapter()` — e.g. the `verify` function from your runtime package ' +
          '(runtime-node uses argon2, runtime-edge uses PBKDF2).',
      );
    },

    async getIdentifier(userId) {
      const row = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return row?.email ?? userId;
    },

    async consumeRecoveryCode(userId, hashedCode) {
      const deleted = await db
        .delete(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hashedCode)))
        .returning({ codeHash: recoveryCodes.codeHash });
      return deleted.length > 0;
    },

    // ── Tier 1 — CoreAuthAdapter optional methods ─────────────────────────────

    async getUser(userId) {
      const row = await db.select().from(users).where(eq(users.id, userId)).then(firstRowOrNull);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email ?? undefined,
        displayName: row.displayName ?? undefined,
        firstName: row.firstName ?? undefined,
        lastName: row.lastName ?? undefined,
        externalId: row.externalId ?? undefined,
        emailVerified: row.emailVerified ?? false,
        suspended: row.suspended ?? false,
        suspendedReason: row.suspendedReason ?? undefined,
        userMetadata: row.userMetadata ?? undefined,
        appMetadata: row.appMetadata ?? undefined,
      };
    },

    async setPassword(userId, passwordHash) {
      await db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async deleteUser(userId) {
      await db.delete(users).where(eq(users.id, userId));
    },

    async setEmailVerified(userId, verified) {
      await db
        .update(users)
        .set({ emailVerified: verified, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async getEmailVerified(userId) {
      const row = await db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return row?.emailVerified ?? false;
    },

    async hasPassword(userId) {
      const row = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return !!row?.passwordHash;
    },

    async updateProfile(userId, fields) {
      await db
        .update(users)
        .set({
          displayName: fields.displayName,
          firstName: fields.firstName,
          lastName: fields.lastName,
          externalId: fields.externalId,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    async getUserMetadata(userId) {
      const row = await db
        .select({ userMetadata: users.userMetadata, appMetadata: users.appMetadata })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return {
        userMetadata: row?.userMetadata ?? undefined,
        appMetadata: row?.appMetadata ?? undefined,
      };
    },

    async setUserMetadata(userId, data) {
      await db
        .update(users)
        .set({ userMetadata: data, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async setAppMetadata(userId, data) {
      await db
        .update(users)
        .set({ appMetadata: data, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    // ── Tier 2 — OAuthAdapter ─────────────────────────────────────────────────

    async findOrCreateByProvider(provider, providerId, profile) {
      const existing = await db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerUserId, providerId)),
        )
        .then(firstRowOrNull);

      if (existing) {
        return { id: existing.userId, created: false };
      }

      const normalizedEmail = profile.email?.toLowerCase();
      if (normalizedEmail) {
        const emailConflict = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, normalizedEmail))
          .then(firstRowOrNull);
        if (emailConflict) {
          throw new HttpError(
            409,
            'An account with this email already exists. Sign in with your credentials, then link the provider from your account settings.',
            'PROVIDER_EMAIL_CONFLICT',
          );
        }
      }

      const id = crypto.randomUUID();
      await db.transaction(async tx => {
        await tx.insert(users).values({
          id,
          email: normalizedEmail,
          emailVerified: false,
          suspended: false,
          displayName: profile.displayName,
          firstName: profile.firstName,
          lastName: profile.lastName,
          externalId: profile.externalId,
        });
        await tx.insert(oauthAccounts).values({ userId: id, provider, providerUserId: providerId });
      });

      return { id, created: true };
    },

    async linkProvider(userId, provider, providerId) {
      await db
        .insert(oauthAccounts)
        .values({ userId, provider, providerUserId: providerId })
        .onConflictDoNothing();
    },

    async unlinkProvider(userId, provider) {
      await db
        .delete(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
    },

    // ── Tier 3 — MfaAdapter ───────────────────────────────────────────────────

    async setMfaSecret(userId, secret) {
      await db
        .update(users)
        .set({ mfaSecret: secret, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async getMfaSecret(userId) {
      const row = await db
        .select({ mfaSecret: users.mfaSecret })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return row?.mfaSecret ?? null;
    },

    async isMfaEnabled(userId) {
      const row = await db
        .select({ mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return row?.mfaEnabled ?? false;
    },

    async setMfaEnabled(userId, enabled) {
      await db
        .update(users)
        .set({ mfaEnabled: enabled, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async setRecoveryCodes(userId, codes) {
      await db.transaction(async tx => {
        await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
        if (codes.length > 0) {
          await tx.insert(recoveryCodes).values(codes.map(codeHash => ({ userId, codeHash })));
        }
      });
    },

    async getRecoveryCodes(userId) {
      const rows = await db
        .select({ codeHash: recoveryCodes.codeHash })
        .from(recoveryCodes)
        .where(eq(recoveryCodes.userId, userId));
      return rows.map(r => r.codeHash);
    },

    async removeRecoveryCode(userId, code) {
      await db
        .delete(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, code)));
    },

    async getMfaMethods(userId) {
      const row = await db
        .select({ mfaMethods: users.mfaMethods })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      return row?.mfaMethods ?? [];
    },

    async setMfaMethods(userId, methods) {
      await db
        .update(users)
        .set({ mfaMethods: methods, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    // ── Tier 4 — WebAuthnAdapter ──────────────────────────────────────────────

    async getWebAuthnCredentials(userId) {
      const rows = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));
      return rows.map(row => ({
        credentialId: row.credentialId,
        publicKey: row.publicKey,
        signCount: row.signCount,
        transports: row.transports ?? undefined,
        name: row.name ?? undefined,
        createdAt: row.createdAt.getTime(),
      }));
    },

    async addWebAuthnCredential(userId, credential) {
      await db.insert(webauthnCredentials).values({
        credentialId: credential.credentialId,
        userId,
        publicKey: credential.publicKey,
        signCount: credential.signCount,
        transports: credential.transports ?? null,
        name: credential.name ?? null,
        createdAt: new Date(credential.createdAt),
      });
    },

    async removeWebAuthnCredential(userId, credentialId) {
      await db
        .delete(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.credentialId, credentialId),
            eq(webauthnCredentials.userId, userId),
          ),
        );
    },

    async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
      await db
        .update(webauthnCredentials)
        .set({ signCount })
        .where(
          and(
            eq(webauthnCredentials.credentialId, credentialId),
            eq(webauthnCredentials.userId, userId),
          ),
        );
    },

    async findUserByWebAuthnCredentialId(credentialId) {
      const row = await db
        .select({ userId: webauthnCredentials.userId })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.credentialId, credentialId))
        .then(firstRowOrNull);
      return row?.userId ?? null;
    },

    // ── Tier 5 — RolesAdapter ─────────────────────────────────────────────────

    async getRoles(userId) {
      const rows = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));
      return rows.map(r => r.role);
    },

    async setRoles(userId, roles) {
      await db.transaction(async tx => {
        await tx.delete(userRoles).where(eq(userRoles.userId, userId));
        if (roles.length > 0) {
          await tx.insert(userRoles).values(roles.map(role => ({ userId, role })));
        }
      });
    },

    async addRole(userId, role) {
      await db.insert(userRoles).values({ userId, role }).onConflictDoNothing();
    },

    async removeRole(userId, role) {
      await db.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)));
    },

    async getTenantRoles(userId, tenantId) {
      const rows = await db
        .select({ role: tenantRoles.role })
        .from(tenantRoles)
        .where(and(eq(tenantRoles.userId, userId), eq(tenantRoles.tenantId, tenantId)));
      return rows.map(r => r.role);
    },

    async setTenantRoles(userId, tenantId, roles) {
      await db.transaction(async tx => {
        await tx
          .delete(tenantRoles)
          .where(and(eq(tenantRoles.userId, userId), eq(tenantRoles.tenantId, tenantId)));
        if (roles.length > 0) {
          await tx.insert(tenantRoles).values(roles.map(role => ({ userId, tenantId, role })));
        }
      });
    },

    async addTenantRole(userId, tenantId, role) {
      await db.insert(tenantRoles).values({ userId, tenantId, role }).onConflictDoNothing();
    },

    async removeTenantRole(userId, tenantId, role) {
      await db
        .delete(tenantRoles)
        .where(
          and(
            eq(tenantRoles.userId, userId),
            eq(tenantRoles.tenantId, tenantId),
            eq(tenantRoles.role, role),
          ),
        );
    },

    // ── Tier 6 — GroupsAdapter ────────────────────────────────────────────────

    async createGroup(group) {
      const id = crypto.randomUUID();
      const now = new Date();
      try {
        await db.insert(groups).values({
          id,
          name: group.name,
          displayName: group.displayName,
          description: group.description,
          roles: group.roles,
          tenantId: group.tenantId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(
            409,
            'A group with this name already exists in this scope',
            'GROUP_NAME_CONFLICT',
          );
        }
        throw err;
      }
      return { id };
    },

    async deleteGroup(groupId) {
      await db.delete(groups).where(eq(groups.id, groupId));
    },

    async getGroup(groupId) {
      const row = await db.select().from(groups).where(eq(groups.id, groupId)).then(firstRowOrNull);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        displayName: row.displayName ?? undefined,
        description: row.description ?? undefined,
        roles: row.roles,
        tenantId: row.tenantId,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      };
    },

    async listGroups(tenantId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;

      const conditions = [
        tenantId === null ? isNull(groups.tenantId) : eq(groups.tenantId, tenantId),
        cursor !== null
          ? or(
              gt(groups.createdAt, new Date(cursor.createdAt)),
              and(eq(groups.createdAt, new Date(cursor.createdAt)), gt(groups.id, cursor.id)),
            )
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const rows = await db
        .select()
        .from(groups)
        .where(and(...conditions))
        .orderBy(asc(groups.createdAt), asc(groups.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];

      return {
        items: page.map(row => ({
          id: row.id,
          name: row.name,
          displayName: row.displayName ?? undefined,
          description: row.description ?? undefined,
          roles: row.roles,
          tenantId: row.tenantId,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime(),
        })),
        nextCursor: hasMore ? encodeCursor(lastRow.createdAt, lastRow.id) : undefined,
        hasMore,
      };
    },

    async updateGroup(groupId, updates) {
      const patch: {
        updatedAt: Date;
        name?: string;
        displayName?: string | null;
        description?: string | null;
        roles?: string[];
      } = { updatedAt: new Date() };

      if (updates.name !== undefined) patch.name = updates.name;
      if ('displayName' in updates) patch.displayName = updates.displayName ?? null;
      if ('description' in updates) patch.description = updates.description ?? null;
      if (updates.roles !== undefined) patch.roles = updates.roles;

      await db.update(groups).set(patch).where(eq(groups.id, groupId));
    },

    async addGroupMember(groupId, userId, roles = []) {
      const group = await db
        .select({ tenantId: groups.tenantId })
        .from(groups)
        .where(eq(groups.id, groupId))
        .then(firstRowOrNull);
      if (!group) throw new HttpError(404, 'Group not found');
      try {
        await db.insert(groupMemberships).values({
          userId,
          groupId,
          roles,
          tenantId: group.tenantId,
          createdAt: new Date(),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(
            409,
            'User is already a member of this group',
            'GROUP_MEMBER_CONFLICT',
          );
        }
        throw err;
      }
    },

    async updateGroupMembership(groupId, userId, roles) {
      await db
        .update(groupMemberships)
        .set({ roles })
        .where(and(eq(groupMemberships.userId, userId), eq(groupMemberships.groupId, groupId)));
    },

    async removeGroupMember(groupId, userId) {
      await db
        .delete(groupMemberships)
        .where(and(eq(groupMemberships.userId, userId), eq(groupMemberships.groupId, groupId)));
    },

    async getGroupMembers(groupId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;

      const conditions = [
        eq(groupMemberships.groupId, groupId),
        cursor !== null
          ? or(
              gt(groupMemberships.createdAt, new Date(cursor.createdAt)),
              and(
                eq(groupMemberships.createdAt, new Date(cursor.createdAt)),
                gt(groupMemberships.userId, cursor.id),
              ),
            )
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const rows = await db
        .select({
          userId: groupMemberships.userId,
          roles: groupMemberships.roles,
          createdAt: groupMemberships.createdAt,
        })
        .from(groupMemberships)
        .where(and(...conditions))
        .orderBy(asc(groupMemberships.createdAt), asc(groupMemberships.userId))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];

      return {
        items: page.map(r => ({ userId: r.userId, roles: r.roles })),
        nextCursor: hasMore ? encodeCursor(lastRow.createdAt, lastRow.userId) : undefined,
        hasMore,
      };
    },

    async getUserGroups(userId, tenantId) {
      const memberCondition =
        tenantId === null
          ? and(eq(groupMemberships.userId, userId), isNull(groupMemberships.tenantId))
          : and(eq(groupMemberships.userId, userId), eq(groupMemberships.tenantId, tenantId));

      const rows = await db
        .select({
          groupId: groups.id,
          groupName: groups.name,
          groupDisplayName: groups.displayName,
          groupDescription: groups.description,
          groupRoles: groups.roles,
          groupTenantId: groups.tenantId,
          groupCreatedAt: groups.createdAt,
          groupUpdatedAt: groups.updatedAt,
          memberRoles: groupMemberships.roles,
        })
        .from(groupMemberships)
        .innerJoin(groups, eq(groupMemberships.groupId, groups.id))
        .where(memberCondition);

      return rows.map(row => ({
        group: {
          id: row.groupId,
          name: row.groupName,
          displayName: row.groupDisplayName ?? undefined,
          description: row.groupDescription ?? undefined,
          roles: row.groupRoles,
          tenantId: row.groupTenantId,
          createdAt: row.groupCreatedAt.getTime(),
          updatedAt: row.groupUpdatedAt.getTime(),
        },
        membershipRoles: row.memberRoles,
      }));
    },

    async getEffectiveRoles(userId, tenantId) {
      // Direct roles
      let direct: string[];
      if (tenantId !== null) {
        const rows = await db
          .select({ role: tenantRoles.role })
          .from(tenantRoles)
          .where(and(eq(tenantRoles.userId, userId), eq(tenantRoles.tenantId, tenantId)));
        direct = rows.map(r => r.role);
      } else {
        const rows = await db
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(eq(userRoles.userId, userId));
        direct = rows.map(r => r.role);
      }

      // Group roles — single JOIN query, not N+1
      const memberCondition =
        tenantId === null
          ? and(eq(groupMemberships.userId, userId), isNull(groupMemberships.tenantId))
          : and(eq(groupMemberships.userId, userId), eq(groupMemberships.tenantId, tenantId));

      const memberRows = await db
        .select({ groupRoles: groups.roles, memberRoles: groupMemberships.roles })
        .from(groupMemberships)
        .innerJoin(groups, eq(groupMemberships.groupId, groups.id))
        .where(memberCondition);

      const fromGroups = memberRows.flatMap(r => [...r.groupRoles, ...r.memberRoles]);

      return [...new Set([...direct, ...fromGroups])];
    },

    // ── Tier 7 — SuspensionAdapter ────────────────────────────────────────────

    async setSuspended(userId, suspended, reason) {
      await db
        .update(users)
        .set({
          suspended,
          suspendedReason: suspended ? (reason ?? null) : null,
          suspendedAt: suspended ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    async getSuspended(userId) {
      const row = await db
        .select({ suspended: users.suspended, suspendedReason: users.suspendedReason })
        .from(users)
        .where(eq(users.id, userId))
        .then(firstRowOrNull);
      if (!row) return null;
      return {
        suspended: row.suspended,
        suspendedReason: row.suspendedReason ?? undefined,
      };
    },

    // ── Tier 8 — EnterpriseAdapter ────────────────────────────────────────────

    async listUsers(query) {
      const { startIndex = 0, count = 50, email: emailFilter, externalId, suspended } = query;
      const limit = Math.min(count, 200);

      const conditions = [
        emailFilter !== undefined ? ilike(users.email, `%${emailFilter}%`) : undefined,
        externalId !== undefined ? eq(users.externalId, externalId) : undefined,
        suspended !== undefined ? eq(users.suspended, suspended) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const { userRows, total } = await db.transaction(async tx => {
        const userRows = await tx
          .select()
          .from(users)
          .where(whereClause)
          .limit(limit)
          .offset(startIndex);
        const countResult = await tx
          .select({ count: sql<string>`count(*)` })
          .from(users)
          .where(whereClause);
        return { userRows, total: Number(countResult[0].count) };
      });

      return {
        users: userRows.map(row => ({
          id: row.id,
          email: row.email ?? undefined,
          displayName: row.displayName ?? undefined,
          firstName: row.firstName ?? undefined,
          lastName: row.lastName ?? undefined,
          externalId: row.externalId ?? undefined,
          emailVerified: row.emailVerified ?? false,
          suspended: row.suspended ?? false,
          suspendedAt: row.suspendedAt ?? undefined,
          suspendedReason: row.suspendedReason ?? undefined,
          userMetadata: row.userMetadata ?? undefined,
          appMetadata: row.appMetadata ?? undefined,
        })),
        totalResults: total,
      };
    },
  };
}

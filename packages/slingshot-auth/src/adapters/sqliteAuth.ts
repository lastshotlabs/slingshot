import type {
  AuthAdapter,
  GroupRecord,
  IdentityProfile,
  RuntimePassword,
  RuntimeSqliteDatabase,
  UserQuery,
  UserRecord,
} from '@lastshotlabs/slingshot-core';
import {
  HttpError,
  decodeCursor,
  encodeCursor,
  runSubsystemMigrations,
} from '@lastshotlabs/slingshot-core';
import { hashToken } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import { normalizeEmail } from '../lib/normalizeEmail';
import {
  isSqliteMissingColumnError,
  isSqliteUnsupportedDropColumnError,
} from '../lib/sqliteSchemaErrors';
import type { OAuthCodePayload } from '../types/oauthCode';
import type { OAuthReauthConfirmation, OAuthReauthState } from '../types/oauthReauth';
import type { SessionInfo, SessionMetadata } from '../types/session';
import type { RefreshResult } from '../types/session';

// ---------------------------------------------------------------------------
// Schema migrations
//
// Tracks applied migrations in the shared _slingshot_migrations table under the
// 'auth' subsystem key. Each entry in MIGRATIONS corresponds to one schema
// version; index 0 = version 1, index 1 = version 2, etc.
//
// To add a new migration: append a function to MIGRATIONS. Never edit or
// reorder existing entries — existing databases will have already applied them.
// ---------------------------------------------------------------------------

type Migration = (db: RuntimeSqliteDatabase) => void;

function dropLegacyRefreshTokenPlainColumn(db: RuntimeSqliteDatabase): void {
  try {
    db.run('UPDATE sessions SET refreshTokenPlain = NULL WHERE refreshTokenPlain IS NOT NULL');
  } catch (err) {
    if (isSqliteMissingColumnError(err, 'refreshTokenPlain')) return;
    throw err;
  }

  try {
    db.run('ALTER TABLE sessions DROP COLUMN refreshTokenPlain');
  } catch (err) {
    if (
      isSqliteMissingColumnError(err, 'refreshTokenPlain') ||
      isSqliteUnsupportedDropColumnError(err)
    ) {
      // Older SQLite engines may not support DROP COLUMN. The plaintext values have
      // already been scrubbed above, so leave the inert legacy column in place.
      return;
    }
    throw err;
  }
}

function parseProviderIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function backfillOAuthProviderLinks(db: RuntimeSqliteDatabase): void {
  const users = db
    .query<{ id: string; providerIds: string }>('SELECT id, providerIds FROM users ORDER BY id ASC')
    .all();
  const owners = new Map<string, string>();
  const conflicts = new Map<string, Set<string>>();

  for (const user of users) {
    const uniqueKeys = new Set(parseProviderIds(user.providerIds));
    for (const key of uniqueKeys) {
      const separator = key.indexOf(':');
      if (separator <= 0 || separator === key.length - 1) continue;
      const existingOwner = owners.get(key);
      if (existingOwner === undefined) {
        owners.set(key, user.id);
        continue;
      }
      if (existingOwner !== user.id) {
        const userIds = conflicts.get(key) ?? new Set<string>([existingOwner]);
        userIds.add(user.id);
        conflicts.set(key, userIds);
      }
    }
  }

  if (conflicts.size > 0) {
    const summary = [...conflicts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 5)
      .map(([key, userIds]) => `${key} -> ${[...userIds].sort().join(', ')}`)
      .join('; ');
    throw new Error(
      `Cannot migrate legacy OAuth provider links because duplicate provider identities are claimed by multiple users. Resolve the conflicts first: ${summary}`,
    );
  }

  db.run('DELETE FROM oauth_provider_links');
  for (const user of users) {
    const normalized: string[] = [];
    for (const key of [...new Set(parseProviderIds(user.providerIds))].sort()) {
      const separator = key.indexOf(':');
      if (separator <= 0 || separator === key.length - 1) continue;
      normalized.push(key);
      db.run(
        'INSERT INTO oauth_provider_links (provider, providerUserId, userId) VALUES (?, ?, ?)',
        [key.slice(0, separator), key.slice(separator + 1), user.id],
      );
    }
    db.run('UPDATE users SET providerIds = ? WHERE id = ?', [JSON.stringify(normalized), user.id]);
  }
}

const MIGRATIONS: Migration[] = [
  // v1: initial schema
  db => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE,
      identifier      TEXT UNIQUE,
      passwordHash    TEXT,
      providerIds     TEXT NOT NULL DEFAULT '[]',
      roles           TEXT NOT NULL DEFAULT '[]',
      emailVerified   INTEGER NOT NULL DEFAULT 0,
      displayName     TEXT,
      firstName       TEXT,
      lastName        TEXT,
      externalId      TEXT,
      suspended       INTEGER NOT NULL DEFAULT 0,
      suspendedAt     TEXT,
      suspendedReason TEXT,
      mfaSecret       TEXT,
      mfaEnabled      INTEGER NOT NULL DEFAULT 0,
      recoveryCodes   TEXT NOT NULL DEFAULT '[]',
      mfaMethods      TEXT NOT NULL DEFAULT '[]',
      passwordHistory TEXT NOT NULL DEFAULT '[]',
      user_metadata   TEXT NOT NULL DEFAULT '{}',
      app_metadata    TEXT NOT NULL DEFAULT '{}'
    )`);
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identifier ON users(identifier) WHERE identifier IS NOT NULL',
    );
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      sessionId         TEXT PRIMARY KEY,
      userId            TEXT NOT NULL,
      token             TEXT,
      createdAt         INTEGER NOT NULL,
      lastActiveAt      INTEGER NOT NULL,
      expiresAt         INTEGER NOT NULL,
      ipAddress         TEXT,
      userAgent         TEXT,
      refreshToken      TEXT,
      prevRefreshToken   TEXT,
      prevTokenExpiresAt INTEGER,
      fingerprint       TEXT,
      mfaVerifiedAt     INTEGER,
      refreshTokenPlain  TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId)');
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refreshToken ON sessions(refreshToken) WHERE refreshToken IS NOT NULL',
    );
    db.run(`CREATE TABLE IF NOT EXISTS oauth_states (
      state        TEXT PRIMARY KEY,
      codeVerifier TEXT,
      linkUserId   TEXT,
      expiresAt    INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cache_entries (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      expiresAt INTEGER  -- NULL = indefinite
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
      token     TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      email     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS password_resets (
      token     TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      email     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS tenant_roles (
      userId    TEXT NOT NULL,
      tenantId  TEXT NOT NULL,
      role      TEXT NOT NULL,
      PRIMARY KEY (userId, tenantId, role)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_tenant_roles_tenant ON tenant_roles(tenantId)');
    db.run(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credentialId TEXT PRIMARY KEY,
      userId       TEXT NOT NULL,
      publicKey    TEXT NOT NULL,
      signCount    INTEGER NOT NULL DEFAULT 0,
      transports   TEXT NOT NULL DEFAULT '[]',
      name         TEXT,
      createdAt    INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_webauthn_userId ON webauthn_credentials(userId)');
    db.run(`CREATE TABLE IF NOT EXISTS groups (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      displayName TEXT,
      description TEXT,
      roles       TEXT    NOT NULL DEFAULT '[]',
      tenantId    TEXT,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    )`);
    // SQLite UNIQUE treats each NULL as distinct, so we use partial indexes instead of
    // a simple UNIQUE constraint on (name, tenantId). This correctly enforces name
    // uniqueness within app-wide scope and within each tenant scope separately.
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_appwide ON groups(name) WHERE tenantId IS NULL',
    );
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_tenant ON groups(name, tenantId) WHERE tenantId IS NOT NULL',
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_groups_tenantId ON groups(tenantId)');
    db.run(`CREATE TABLE IF NOT EXISTS group_memberships (
      userId    TEXT    NOT NULL,
      groupId   TEXT    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      roles     TEXT    NOT NULL DEFAULT '[]',
      tenantId  TEXT,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (userId, groupId)
    )`);
    // NOTE: PRAGMA foreign_keys = ON must run per-connection.
    db.run('CREATE INDEX IF NOT EXISTS idx_gm_groupId ON group_memberships(groupId)');
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_gm_userId_tenantId ON group_memberships(userId, tenantId)',
    );
    db.run(`CREATE TABLE IF NOT EXISTS oauth_codes (
      codeHash     TEXT PRIMARY KEY,
      token        TEXT NOT NULL,
      userId       TEXT NOT NULL,
      email        TEXT,
      refreshToken TEXT,
      expiresAt    INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS deletion_cancel_tokens (
      token     TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      jobId     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS magic_link_tokens (
      token     TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS oauth_reauth_states (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      provider  TEXT NOT NULL,
      purpose   TEXT NOT NULL,
      returnUrl TEXT,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS oauth_reauth_confirmations (
      codeHash  TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      purpose   TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    try {
      db.run('ALTER TABLE oauth_reauth_confirmations ADD COLUMN sessionId TEXT');
    } catch {
      // Column already exists.
    }
    db.run(`CREATE TABLE IF NOT EXISTS upload_registry (
      key           TEXT PRIMARY KEY,
      ownerUserId   TEXT,
      tenantId      TEXT,
      mimeType      TEXT,
      bucket        TEXT,
      createdAt     INTEGER NOT NULL
    )`);
  },
  // v2: M2M clients table
  db => {
    db.run(`CREATE TABLE IF NOT EXISTS m2m_clients (
      id               TEXT    PRIMARY KEY,
      clientId         TEXT    NOT NULL UNIQUE,
      clientSecretHash TEXT    NOT NULL,
      name             TEXT    NOT NULL,
      scopes           TEXT    NOT NULL DEFAULT '[]',
      active           INTEGER NOT NULL DEFAULT 1,
      createdAt        INTEGER NOT NULL
    )`);
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_m2m_clients_clientId ON m2m_clients(clientId)');
  },
  // v3: remove legacy plaintext refresh-token storage
  db => {
    dropLegacyRefreshTokenPlainColumn(db);
  },
  // v4: normalize OAuth provider links into a unique table
  db => {
    db.run(`CREATE TABLE IF NOT EXISTS oauth_provider_links (
      provider       TEXT NOT NULL,
      providerUserId TEXT NOT NULL,
      userId         TEXT NOT NULL,
      PRIMARY KEY (provider, providerUserId)
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_oauth_provider_links_userId ON oauth_provider_links(userId)',
    );
    backfillOAuthProviderLinks(db);
  },
  // Add future migrations here. Each entry is applied exactly once to any
  // database whose _slingshot_migrations version for 'auth' is less than the entry's 1-based index.
  // Example:
  //   (db) => { db.run('ALTER TABLE users ADD COLUMN phoneNumber TEXT'); },
];

function runMigrations(db: RuntimeSqliteDatabase): void {
  runSubsystemMigrations(db, 'auth', MIGRATIONS);
}

// ---------------------------------------------------------------------------
// Result type for the factory
// ---------------------------------------------------------------------------

/**
 * Return type of `createSqliteAuthAdapter`.
 *
 * Bundles the `AuthAdapter`, the underlying `RuntimeSqliteDatabase` handle, a periodic
 * cleanup interval, and low-level session helpers used by the bootstrap layer to wire
 * session operations without a separate `SessionRepository` instance.
 *
 * @remarks
 * The session helpers on this type overlap with `SessionRepository` methods. When used
 * via the full plugin (not standalone), the session operations are handled by the
 * `SessionRepository` resolved from `sessionFactories` rather than these helpers.
 */
export interface SqliteAuthResult {
  db: RuntimeSqliteDatabase;
  adapter: AuthAdapter;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  // Session helpers
  atomicCreateSession: (
    userId: string,
    token: string,
    sessionId: string,
    maxSessions: number,
    getConfig: () => AuthResolvedConfig,
    metadata?: SessionMetadata,
  ) => void;
  createSession: (
    userId: string,
    token: string,
    sessionId: string,
    getConfig: () => AuthResolvedConfig,
    metadata?: SessionMetadata,
  ) => void;
  getSession: (sessionId: string) => string | null;
  getSessionRecord: (sessionId: string) => { token: string; lastActiveAt: number } | null;
  deleteSession: (sessionId: string, getConfig: () => AuthResolvedConfig) => void;
  getUserSessions: (userId: string, getConfig: () => AuthResolvedConfig) => SessionInfo[];
  getActiveSessionCount: (userId: string) => number;
  evictOldestSession: (userId: string, getConfig: () => AuthResolvedConfig) => void;
  updateSessionLastActive: (sessionId: string) => void;
  // Refresh token helpers
  setRefreshToken: (sessionId: string, refreshToken: string) => void;
  getSessionByRefreshToken: (
    refreshToken: string,
    getConfig: () => AuthResolvedConfig,
  ) => RefreshResult | null;
  rotateRefreshToken: (
    sessionId: string,
    newRefreshToken: string,
    newAccessToken: string,
    getConfig: () => AuthResolvedConfig,
  ) => void;
  getSessionFingerprint: (sessionId: string) => string | null;
  setSessionFingerprint: (sessionId: string, fingerprint: string) => void;
  getMfaVerifiedAt: (sessionId: string) => number | null;
  setMfaVerifiedAt: (sessionId: string, ts: number) => void;
  // OAuth state helpers
  storeOAuthState: (state: string, codeVerifier?: string, linkUserId?: string) => void;
  consumeOAuthState: (state: string) => { codeVerifier?: string; linkUserId?: string } | null;
  // Cache helpers
  getCache: (key: string) => string | null;
  setCache: (key: string, value: string, ttlSeconds?: number) => void;
  delCache: (key: string) => void;
  delCachePattern: (pattern: string) => void;
  // Email verification helpers
  createVerificationToken: (
    token: string,
    userId: string,
    email: string,
    ttlSeconds: number,
  ) => void;
  getVerificationToken: (token: string) => { userId: string; email: string } | null;
  deleteVerificationToken: (token: string) => void;
  consumeVerificationToken: (token: string) => { userId: string; email: string } | null;
  // Password reset helpers
  createResetToken: (token: string, userId: string, email: string, ttlSeconds: number) => void;
  consumeResetToken: (hash: string) => { userId: string; email: string } | null;
  // Deletion cancel token helpers
  createDeletionCancelToken: (
    token: string,
    userId: string,
    jobId: string,
    ttlSeconds: number,
  ) => void;
  consumeDeletionCancelToken: (hash: string) => { userId: string; jobId: string } | null;
  // OAuth code helpers
  storeOAuthCode: (hash: string, payload: OAuthCodePayload, ttlSeconds: number) => void;
  consumeOAuthCode: (hash: string) => OAuthCodePayload | null;
  // OAuth re-auth helpers
  storeOAuthReauth: (hash: string, data: OAuthReauthState, ttlSeconds: number) => void;
  consumeOAuthReauth: (hash: string) => OAuthReauthState | null;
  storeOAuthReauthConfirmation: (
    hash: string,
    data: OAuthReauthConfirmation,
    ttlSeconds: number,
  ) => void;
  consumeOAuthReauthConfirmation: (hash: string) => OAuthReauthConfirmation | null;
  // Upload registry helpers
  registerUpload: (record: {
    key: string;
    ownerUserId?: string;
    tenantId?: string;
    mimeType?: string;
    bucket?: string;
    createdAt: number;
  }) => void;
  getUploadRecord: (key: string) => {
    key: string;
    ownerUserId?: string;
    tenantId?: string;
    mimeType?: string;
    bucket?: string;
    createdAt: number;
  } | null;
  deleteUploadRecord: (key: string) => boolean;
  // Magic link helpers
  createMagicLinkToken: (token: string, userId: string, ttlSeconds: number) => void;
  consumeMagicLinkToken: (hash: string) => string | null;
  // Cleanup control
  startCleanup: (
    getConfig: () => AuthResolvedConfig,
    intervalMs?: number,
  ) => ReturnType<typeof setInterval>;
  stopCleanup: () => void;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface SqliteCursorPayload {
  createdAt: number;
  id: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000; // 7 days

/**
 * Creates a SQLite-backed `AuthAdapter` plus session helper methods for the bootstrap layer.
 *
 * Runs schema migrations (`runMigrations`) at construction time and sets `PRAGMA journal_mode = WAL`
 * and `PRAGMA foreign_keys = ON` for reliability. The adapter starts a periodic cleanup interval
 * when `startCleanup` is called (done automatically during plugin bootstrap).
 *
 * @param db - An open `RuntimeSqliteDatabase` handle.
 * @param passwordRuntime - Optional password hashing runtime. When omitted, password verification
 *   falls back to a plain string comparison (development only — not suitable for production).
 * @returns A `SqliteAuthResult` containing the adapter, the db handle, and session helpers.
 *
 * @example
 * import { createSqliteAuthAdapter } from '@lastshotlabs/slingshot-auth';
 * import { openSqlite } from '@lastshotlabs/slingshot-core';
 *
 * const db = openSqlite('/data/auth.db');
 * const { adapter } = createSqliteAuthAdapter(db);
 *
 * @remarks
 * Requires the `bun:sqlite` module or a compatible `RuntimeSqliteDatabase` implementation.
 * Not supported in environments without SQLite support.
 */
export function createSqliteAuthAdapter(
  db: RuntimeSqliteDatabase,
  passwordRuntime?: RuntimePassword,
): SqliteAuthResult {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db);

  let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

  function runCleanup(getConfig: () => AuthResolvedConfig): void {
    const now = Date.now();
    if (getConfig().persistSessionMetadata) {
      // Null out tokens for expired sessions but keep the metadata row
      db.run('UPDATE sessions SET token = NULL WHERE expiresAt <= ? AND token IS NOT NULL', [now]);
    } else {
      db.run('DELETE FROM sessions WHERE expiresAt <= ?', [now]);
    }
    db.run('DELETE FROM oauth_states WHERE expiresAt <= ?', [now]);
    db.run('DELETE FROM cache_entries WHERE expiresAt IS NOT NULL AND expiresAt <= ?', [now]);
    db.run('DELETE FROM email_verifications WHERE expiresAt <= ?', [now]);
    db.run('DELETE FROM password_resets WHERE expiresAt <= ?', [now]);
    db.run('DELETE FROM oauth_codes WHERE expiresAt <= ?', [now]);
    db.run('DELETE FROM oauth_reauth_states WHERE expiresAt <= ?', [now]);
    db.run('DELETE FROM oauth_reauth_confirmations WHERE expiresAt <= ?', [now]);
  }

  function getSessionTtlMs(getConfig: () => AuthResolvedConfig): number {
    const abs = getConfig().sessionPolicy.absoluteTimeout;
    return abs ? abs * 1000 : DEFAULT_SESSION_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Auth adapter
  // ---------------------------------------------------------------------------

  const adapter: AuthAdapter = {
    async findByEmail(email) {
      const row = db
        .query<{
          id: string;
          passwordHash: string;
        }>('SELECT id, passwordHash FROM users WHERE email = ?')
        .get(normalizeEmail(email));
      return row ?? null;
    },

    verifyPassword(userId, password) {
      const row = db
        .query<{ passwordHash: string | null }>('SELECT passwordHash FROM users WHERE id = ?')
        .get(userId);
      if (!row?.passwordHash) return Promise.resolve(false);
      if (!passwordRuntime)
        throw new Error('[slingshot-auth] RuntimePassword is required for verifyPassword');
      return passwordRuntime.verify(password, row.passwordHash);
    },

    getIdentifier(userId) {
      const row = db
        .query<{
          identifier: string | null;
          email: string | null;
        }>('SELECT identifier, email FROM users WHERE id = ?')
        .get(userId);
      return Promise.resolve(row?.identifier ?? row?.email ?? '');
    },

    async create(email, passwordHash) {
      const id = crypto.randomUUID();
      const normalized = normalizeEmail(email);
      try {
        db.run('INSERT INTO users (id, email, identifier, passwordHash) VALUES (?, ?, ?, ?)', [
          id,
          normalized,
          normalized,
          passwordHash,
        ]);
        return { id };
      } catch (err: unknown) {
        if ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE')
          throw new HttpError(409, 'Email already registered');
        throw err;
      }
    },

    async setPassword(userId, passwordHash) {
      db.run('UPDATE users SET passwordHash = ? WHERE id = ?', [passwordHash, userId]);
    },

    async getPasswordHistory(userId) {
      const row = db
        .query<{ passwordHistory: string }>('SELECT passwordHistory FROM users WHERE id = ?')
        .get(userId);
      if (!row) return [];
      try {
        return JSON.parse(row.passwordHistory) as string[];
      } catch {
        return [];
      }
    },

    async addPasswordToHistory(userId, hash, maxCount) {
      const row = db
        .query<{ passwordHistory: string }>('SELECT passwordHistory FROM users WHERE id = ?')
        .get(userId);
      if (!row) return;
      let history: string[];
      try {
        history = JSON.parse(row.passwordHistory) as string[];
      } catch {
        history = [];
      }
      history.push(hash);
      // Keep only the most recent maxCount entries
      if (history.length > maxCount) history = history.slice(-maxCount);
      db.run('UPDATE users SET passwordHistory = ? WHERE id = ?', [
        JSON.stringify(history),
        userId,
      ]);
    },

    async findOrCreateByProvider(provider, providerId, profile) {
      const key = `${provider}:${providerId}`;

      const existing = db
        .query<{
          id: string;
        }>(
          'SELECT userId AS id FROM oauth_provider_links WHERE provider = ? AND providerUserId = ?',
        )
        .get(provider, providerId);
      if (existing) return { id: existing.id, created: false };

      // Reject if email belongs to a credential account
      if (profile.email) {
        const emailUser = db
          .query<{ id: string }>('SELECT id FROM users WHERE email = ?')
          .get(normalizeEmail(profile.email));
        if (emailUser)
          throw new HttpError(
            409,
            'An account with this email already exists. Sign in with your credentials, then link Google from your account settings.',
          );
      }

      const id = crypto.randomUUID();
      const normalizedEmail = profile.email ? normalizeEmail(profile.email) : null;
      db.transaction(() => {
        db.run('INSERT INTO users (id, email, identifier, providerIds) VALUES (?, ?, ?, ?)', [
          id,
          normalizedEmail,
          normalizedEmail,
          JSON.stringify([key]),
        ]);
        db.run(
          'INSERT INTO oauth_provider_links (provider, providerUserId, userId) VALUES (?, ?, ?)',
          [provider, providerId, id],
        );
      })();
      return { id, created: true };
    },

    async linkProvider(userId, provider, providerId) {
      const key = `${provider}:${providerId}`;
      db.transaction(() => {
        const row = db
          .query<{
            id: string;
            providerIds: string;
          }>('SELECT id, providerIds FROM users WHERE id = ?')
          .get(userId);
        if (!row) throw new HttpError(404, 'User not found');

        const existingOwner = db
          .query<{
            userId: string;
          }>('SELECT userId FROM oauth_provider_links WHERE provider = ? AND providerUserId = ?')
          .get(provider, providerId);
        if (existingOwner && existingOwner.userId !== userId) {
          throw new HttpError(
            409,
            'This provider account is already linked to another user. Unlink it there before linking it here.',
          );
        }

        const ids = parseProviderIds(row.providerIds);
        if (!ids.includes(key)) {
          db.run('UPDATE users SET providerIds = ? WHERE id = ?', [
            JSON.stringify([...ids, key]),
            userId,
          ]);
        }
        db.run(
          `INSERT INTO oauth_provider_links (provider, providerUserId, userId)
           VALUES (?, ?, ?)
           ON CONFLICT(provider, providerUserId) DO UPDATE SET userId = excluded.userId`,
          [provider, providerId, userId],
        );
      })();
    },

    async getRoles(userId) {
      const row = db.query<{ roles: string }>('SELECT roles FROM users WHERE id = ?').get(userId);
      return row ? (JSON.parse(row.roles) as string[]) : [];
    },

    async setRoles(userId, roles) {
      db.run('UPDATE users SET roles = ? WHERE id = ?', [JSON.stringify(roles), userId]);
    },

    async addRole(userId, role) {
      const row = db.query<{ roles: string }>('SELECT roles FROM users WHERE id = ?').get(userId);
      if (!row) return;
      const roles = JSON.parse(row.roles) as string[];
      if (!roles.includes(role)) {
        db.run('UPDATE users SET roles = ? WHERE id = ?', [
          JSON.stringify([...roles, role]),
          userId,
        ]);
      }
    },

    async removeRole(userId, role) {
      const row = db.query<{ roles: string }>('SELECT roles FROM users WHERE id = ?').get(userId);
      if (!row) return;
      const roles = JSON.parse(row.roles) as string[];
      db.run('UPDATE users SET roles = ? WHERE id = ?', [
        JSON.stringify(roles.filter(r => r !== role)),
        userId,
      ]);
    },

    async getUser(userId) {
      const row = db
        .query<{
          id: string;
          email: string | null;
          providerIds: string;
          emailVerified: number;
          displayName: string | null;
          firstName: string | null;
          lastName: string | null;
          externalId: string | null;
          suspended: number;
          suspendedReason: string | null;
          user_metadata: string;
          app_metadata: string;
        }>(
          'SELECT id, email, providerIds, emailVerified, displayName, firstName, lastName, externalId, suspended, suspendedReason, user_metadata, app_metadata FROM users WHERE id = ?',
        )
        .get(userId);
      if (!row) return null;
      const userMeta = JSON.parse(row.user_metadata || '{}') as Record<string, unknown>;
      const appMeta = JSON.parse(row.app_metadata || '{}') as Record<string, unknown>;
      return {
        id: row.id,
        email: row.email ?? undefined,
        providerIds: parseProviderIds(row.providerIds),
        emailVerified: row.emailVerified === 1,
        displayName: row.displayName ?? undefined,
        firstName: row.firstName ?? undefined,
        lastName: row.lastName ?? undefined,
        externalId: row.externalId ?? undefined,
        suspended: row.suspended === 1,
        suspendedReason: row.suspendedReason ?? undefined,
        userMetadata: Object.keys(userMeta).length > 0 ? userMeta : undefined,
        appMetadata: Object.keys(appMeta).length > 0 ? appMeta : undefined,
      };
    },

    async unlinkProvider(userId, provider) {
      const row = db
        .query<{ providerIds: string }>('SELECT providerIds FROM users WHERE id = ?')
        .get(userId);
      if (!row) throw new HttpError(404, 'User not found');
      const ids = parseProviderIds(row.providerIds);
      db.transaction(() => {
        db.run('DELETE FROM oauth_provider_links WHERE userId = ? AND provider = ?', [
          userId,
          provider,
        ]);
        db.run('UPDATE users SET providerIds = ? WHERE id = ?', [
          JSON.stringify(ids.filter(id => !id.startsWith(`${provider}:`))),
          userId,
        ]);
      })();
    },

    async findByIdentifier(value) {
      const normalized = normalizeEmail(value);
      const row = db
        .query<{
          id: string;
          passwordHash: string | null;
        }>('SELECT id, passwordHash FROM users WHERE identifier = ? OR email = ? LIMIT 1')
        .get(normalized, normalized);
      if (!row) return null;
      return { id: row.id, passwordHash: row.passwordHash ?? '' };
    },

    async setEmailVerified(userId, verified) {
      db.run('UPDATE users SET emailVerified = ? WHERE id = ?', [verified ? 1 : 0, userId]);
    },

    async getEmailVerified(userId) {
      const row = db
        .query<{ emailVerified: number }>('SELECT emailVerified FROM users WHERE id = ?')
        .get(userId);
      return row?.emailVerified === 1;
    },
    async deleteUser(userId) {
      db.transaction(() => {
        db.run('DELETE FROM sessions WHERE userId = ?', [userId]);
        db.run('DELETE FROM oauth_provider_links WHERE userId = ?', [userId]);
        db.run('DELETE FROM tenant_roles WHERE userId = ?', [userId]);
        db.run('DELETE FROM group_memberships WHERE userId = ?', [userId]);
        db.run('DELETE FROM webauthn_credentials WHERE userId = ?', [userId]);
        db.run('DELETE FROM users WHERE id = ?', [userId]);
      })();
    },
    async hasPassword(userId) {
      const row = db
        .query<{ passwordHash: string | null }>('SELECT passwordHash FROM users WHERE id = ?')
        .get(userId);
      return !!row?.passwordHash;
    },
    async setMfaSecret(userId, secret) {
      db.run('UPDATE users SET mfaSecret = ? WHERE id = ?', [secret, userId]);
    },
    async getMfaSecret(userId) {
      const row = db
        .query<{ mfaSecret: string | null }>('SELECT mfaSecret FROM users WHERE id = ?')
        .get(userId);
      return row?.mfaSecret ?? null;
    },
    async isMfaEnabled(userId) {
      const row = db
        .query<{ mfaEnabled: number }>('SELECT mfaEnabled FROM users WHERE id = ?')
        .get(userId);
      return row?.mfaEnabled === 1;
    },
    async setMfaEnabled(userId, enabled) {
      db.run('UPDATE users SET mfaEnabled = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
    },
    async setRecoveryCodes(userId, codes) {
      db.run('UPDATE users SET recoveryCodes = ? WHERE id = ?', [JSON.stringify(codes), userId]);
    },
    async getRecoveryCodes(userId) {
      const row = db
        .query<{ recoveryCodes: string }>('SELECT recoveryCodes FROM users WHERE id = ?')
        .get(userId);
      return row?.recoveryCodes ? (JSON.parse(row.recoveryCodes) as string[]) : [];
    },
    async removeRecoveryCode(userId, code) {
      db.transaction(() => {
        const row = db
          .query<{ recoveryCodes: string }>('SELECT recoveryCodes FROM users WHERE id = ?')
          .get(userId);
        if (!row) return;
        let codes: string[];
        try {
          codes = JSON.parse(row.recoveryCodes || '[]') as string[];
        } catch {
          return;
        }
        const idx = codes.indexOf(code);
        if (idx !== -1) {
          codes.splice(idx, 1);
          db.run('UPDATE users SET recoveryCodes = ? WHERE id = ?', [
            JSON.stringify(codes),
            userId,
          ]);
        }
      })();
    },
    consumeRecoveryCode(userId, hashedCode) {
      // Wrap the read-splice-write in a SQLite transaction so it is atomic.
      const result = db.transaction(() => {
        const row = db
          .query<{ recoveryCodes: string }>('SELECT recoveryCodes FROM users WHERE id = ?')
          .get(userId);
        if (!row) return false;

        let codes: string[];
        try {
          codes = JSON.parse(row.recoveryCodes || '[]') as string[];
        } catch {
          return false;
        }

        const idx = codes.indexOf(hashedCode);
        if (idx === -1) return false;

        codes.splice(idx, 1);
        db.run('UPDATE users SET recoveryCodes = ? WHERE id = ?', [JSON.stringify(codes), userId]);
        return true;
      })();

      return Promise.resolve(result);
    },
    async getMfaMethods(userId) {
      const row = db
        .query<{ mfaMethods: string }>('SELECT mfaMethods FROM users WHERE id = ?')
        .get(userId);
      return row?.mfaMethods ? (JSON.parse(row.mfaMethods) as string[]) : [];
    },
    async setMfaMethods(userId, methods) {
      db.run('UPDATE users SET mfaMethods = ? WHERE id = ?', [JSON.stringify(methods), userId]);
    },
    async getWebAuthnCredentials(userId) {
      const rows = db
        .query<{
          credentialId: string;
          publicKey: string;
          signCount: number;
          transports: string;
          name: string | null;
          createdAt: number;
        }>(
          'SELECT credentialId, publicKey, signCount, transports, name, createdAt FROM webauthn_credentials WHERE userId = ?',
        )
        .all(userId);
      return rows.map(r => ({
        credentialId: r.credentialId,
        publicKey: r.publicKey,
        signCount: r.signCount,
        transports: JSON.parse(r.transports) as string[],
        name: r.name ?? undefined,
        createdAt: r.createdAt,
      }));
    },
    async addWebAuthnCredential(userId, credential) {
      db.run(
        'INSERT INTO webauthn_credentials (credentialId, userId, publicKey, signCount, transports, name, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          credential.credentialId,
          userId,
          credential.publicKey,
          credential.signCount,
          JSON.stringify(credential.transports ?? []),
          credential.name ?? null,
          credential.createdAt,
        ],
      );
    },
    async removeWebAuthnCredential(userId, credentialId) {
      db.run('DELETE FROM webauthn_credentials WHERE credentialId = ? AND userId = ?', [
        credentialId,
        userId,
      ]);
    },
    async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
      db.run(
        'UPDATE webauthn_credentials SET signCount = ? WHERE credentialId = ? AND userId = ?',
        [signCount, credentialId, userId],
      );
    },
    async findUserByWebAuthnCredentialId(credentialId) {
      const row = db
        .query<{ userId: string }>('SELECT userId FROM webauthn_credentials WHERE credentialId = ?')
        .get(credentialId);
      return row?.userId ?? null;
    },
    async getTenantRoles(userId, tenantId) {
      const rows = db
        .query<{ role: string }>('SELECT role FROM tenant_roles WHERE userId = ? AND tenantId = ?')
        .all(userId, tenantId);
      return rows.map(r => r.role);
    },
    async setTenantRoles(userId, tenantId, roles) {
      db.run('DELETE FROM tenant_roles WHERE userId = ? AND tenantId = ?', [userId, tenantId]);
      const stmt = db.prepare('INSERT INTO tenant_roles (userId, tenantId, role) VALUES (?, ?, ?)');
      for (const role of roles) {
        stmt.run(userId, tenantId, role);
      }
    },
    async addTenantRole(userId, tenantId, role) {
      try {
        db.run('INSERT INTO tenant_roles (userId, tenantId, role) VALUES (?, ?, ?)', [
          userId,
          tenantId,
          role,
        ]);
      } catch {
        /* already exists */
      }
    },
    async removeTenantRole(userId, tenantId, role) {
      db.run('DELETE FROM tenant_roles WHERE userId = ? AND tenantId = ? AND role = ?', [
        userId,
        tenantId,
        role,
      ]);
    },

    async setSuspended(userId: string, suspended: boolean, reason?: string | null) {
      if (suspended) {
        db.run(
          'UPDATE users SET suspended = 1, suspendedAt = ?, suspendedReason = ? WHERE id = ?',
          [new Date().toISOString(), reason ?? null, userId],
        );
      } else {
        db.run(
          'UPDATE users SET suspended = 0, suspendedAt = NULL, suspendedReason = NULL WHERE id = ?',
          [userId],
        );
      }
    },

    async getSuspended(userId: string) {
      const row = db
        .query<{
          suspended: number;
          suspendedReason: string | null;
        }>('SELECT suspended, suspendedReason FROM users WHERE id = ?')
        .get(userId);
      if (!row) return null;
      return { suspended: row.suspended === 1, suspendedReason: row.suspendedReason ?? undefined };
    },

    async updateProfile(
      userId: string,
      fields: Partial<
        Pick<IdentityProfile, 'displayName' | 'firstName' | 'lastName' | 'externalId'> & {
          userMetadata?: Record<string, unknown>;
        }
      >,
    ) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if ('displayName' in fields) {
        sets.push('displayName = ?');
        params.push(fields.displayName ?? null);
      }
      if ('firstName' in fields) {
        sets.push('firstName = ?');
        params.push(fields.firstName ?? null);
      }
      if ('lastName' in fields) {
        sets.push('lastName = ?');
        params.push(fields.lastName ?? null);
      }
      if ('externalId' in fields) {
        sets.push('externalId = ?');
        params.push(fields.externalId ?? null);
      }
      if ('userMetadata' in fields) {
        sets.push('user_metadata = ?');
        params.push(JSON.stringify(fields.userMetadata ?? {}));
      }
      if (sets.length === 0) return;
      params.push(userId);
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params as string[]);
    },

    async getUserMetadata(userId: string) {
      const row = db
        .query<{
          user_metadata: string;
          app_metadata: string;
        }>('SELECT user_metadata, app_metadata FROM users WHERE id = ?')
        .get(userId);
      if (!row) return {};
      const userMeta = JSON.parse(row.user_metadata || '{}') as Record<string, unknown>;
      const appMeta = JSON.parse(row.app_metadata || '{}') as Record<string, unknown>;
      return {
        userMetadata: Object.keys(userMeta).length > 0 ? userMeta : undefined,
        appMetadata: Object.keys(appMeta).length > 0 ? appMeta : undefined,
      };
    },

    async setUserMetadata(userId: string, data: Record<string, unknown>) {
      db.run('UPDATE users SET user_metadata = ? WHERE id = ?', [JSON.stringify(data), userId]);
    },

    async setAppMetadata(userId: string, data: Record<string, unknown>) {
      db.run('UPDATE users SET app_metadata = ? WHERE id = ?', [JSON.stringify(data), userId]);
    },

    async listUsers(query: UserQuery) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (query.email !== undefined) {
        conditions.push('email = ?');
        params.push(query.email);
      }
      if (query.externalId !== undefined) {
        conditions.push('externalId = ?');
        params.push(query.externalId);
      }
      if (query.suspended !== undefined) {
        conditions.push('suspended = ?');
        params.push(query.suspended ? 1 : 0);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const startIndex = query.startIndex ?? 0;
      const count = query.count ?? 100;

      type UserRow = {
        id: string;
        email: string | null;
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
        externalId: string | null;
        suspended: number;
        suspendedAt: string | null;
        suspendedReason: string | null;
        emailVerified: number;
        providerIds: string;
      };

      const queryParams = [...(params as (string | number | null)[]), count, startIndex];
      const countParams = params as (string | number | null)[];

      const rows = db
        .prepare<UserRow>(
          `SELECT id, email, displayName, firstName, lastName, externalId, suspended, suspendedAt, suspendedReason, emailVerified, providerIds FROM users ${where} LIMIT ? OFFSET ?`,
        )
        .all(...queryParams);

      const totalRow = db
        .prepare<{ c: number }>(`SELECT COUNT(*) as c FROM users ${where}`)
        .get(...countParams);

      const totalResults = totalRow?.c ?? 0;

      return {
        users: rows.map(r => ({
          id: r.id,
          email: r.email ?? undefined,
          displayName: r.displayName ?? undefined,
          firstName: r.firstName ?? undefined,
          lastName: r.lastName ?? undefined,
          externalId: r.externalId ?? undefined,
          suspended: r.suspended === 1,
          suspendedAt: r.suspendedAt ? new Date(r.suspendedAt) : undefined,
          suspendedReason: r.suspendedReason ?? undefined,
          emailVerified: r.emailVerified === 1,
          providerIds: parseProviderIds(r.providerIds),
        })) as UserRecord[],
        totalResults,
      };
    },

    // ---------------------------------------------------------------------------
    // Groups
    // ---------------------------------------------------------------------------

    async createGroup(group) {
      const id = crypto.randomUUID();
      const now = Date.now();
      try {
        db.run(
          'INSERT INTO groups (id, name, displayName, description, roles, tenantId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            group.name,
            group.displayName ?? null,
            group.description ?? null,
            JSON.stringify(group.roles),
            group.tenantId ?? null,
            now,
            now,
          ],
        );
      } catch (err: unknown) {
        const code = (err as { code?: unknown }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new HttpError(409, 'A group with this name already exists in this scope');
        }
        throw err;
      }
      return { id };
    },

    async deleteGroup(groupId) {
      // group_memberships are cascade-deleted via ON DELETE CASCADE (requires PRAGMA foreign_keys = ON)
      db.run('DELETE FROM groups WHERE id = ?', [groupId]);
    },

    async getGroup(groupId) {
      const row = db
        .query<{
          id: string;
          name: string;
          displayName: string | null;
          description: string | null;
          roles: string;
          tenantId: string | null;
          createdAt: number;
          updatedAt: number;
        }>(
          'SELECT id, name, displayName, description, roles, tenantId, createdAt, updatedAt FROM groups WHERE id = ?',
        )
        .get(groupId);
      if (!row) return null;
      return {
        ...row,
        displayName: row.displayName ?? undefined,
        description: row.description ?? undefined,
        roles: JSON.parse(row.roles) as string[],
      };
    },

    async listGroups(tenantId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      type GroupRow = {
        id: string;
        name: string;
        displayName: string | null;
        description: string | null;
        roles: string;
        tenantId: string | null;
        createdAt: number;
        updatedAt: number;
      };
      const cols = 'id, name, displayName, description, roles, tenantId, createdAt, updatedAt';
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (tenantId === null) {
        conditions.push('tenantId IS NULL');
      } else {
        conditions.push('tenantId = ?');
        params.push(tenantId);
      }
      if (opts?.cursor) {
        const c = decodeCursor<SqliteCursorPayload>(opts.cursor);
        if (c) {
          conditions.push('(createdAt > ? OR (createdAt = ? AND id > ?))');
          params.push(c.createdAt, c.createdAt, c.id);
        }
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit + 1);
      const rows = db
        .query<GroupRow>(
          `SELECT ${cols} FROM groups ${where} ORDER BY createdAt ASC, id ASC LIMIT ?`,
        )
        .all(...params);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? encodeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id })
        : undefined;
      const items = page.map(r => ({
        ...r,
        displayName: r.displayName ?? undefined,
        description: r.description ?? undefined,
        roles: JSON.parse(r.roles) as string[],
      }));
      return { items, nextCursor, hasMore: !!nextCursor };
    },

    async updateGroup(groupId, updates) {
      const now = Date.now();
      const sets: string[] = ['updatedAt = ?'];
      const params: unknown[] = [now];
      if (updates.name !== undefined) {
        sets.push('name = ?');
        params.push(updates.name);
      }
      if ('displayName' in updates) {
        sets.push('displayName = ?');
        params.push(updates.displayName ?? null);
      }
      if ('description' in updates) {
        sets.push('description = ?');
        params.push(updates.description ?? null);
      }
      if (updates.roles !== undefined) {
        sets.push('roles = ?');
        params.push(JSON.stringify(updates.roles));
      }
      params.push(groupId);
      db.run(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`, params as string[]);
    },

    async addGroupMember(groupId, userId, roles = []) {
      const group = db
        .query<{ tenantId: string | null }>('SELECT tenantId FROM groups WHERE id = ?')
        .get(groupId);
      if (!group) throw new HttpError(404, 'Group not found');
      try {
        db.run(
          'INSERT INTO group_memberships (userId, groupId, roles, tenantId, createdAt) VALUES (?, ?, ?, ?, ?)',
          [userId, groupId, JSON.stringify(roles), group.tenantId ?? null, Date.now()],
        );
      } catch (err: unknown) {
        const code = (err as { code?: unknown }).code;
        if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw new HttpError(409, 'User is already a member of this group');
        }
        throw err;
      }
    },

    async updateGroupMembership(groupId, userId, roles) {
      db.run('UPDATE group_memberships SET roles = ? WHERE userId = ? AND groupId = ?', [
        JSON.stringify(roles),
        userId,
        groupId,
      ]);
    },

    async removeGroupMember(groupId, userId) {
      db.run('DELETE FROM group_memberships WHERE userId = ? AND groupId = ?', [userId, groupId]);
    },

    async getGroupMembers(groupId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const conditions: string[] = ['groupId = ?'];
      const params: (string | number)[] = [groupId];
      if (opts?.cursor) {
        const c = decodeCursor<SqliteCursorPayload>(opts.cursor);
        if (c) {
          conditions.push('(createdAt > ? OR (createdAt = ? AND userId > ?))');
          params.push(c.createdAt, c.createdAt, c.id);
        }
      }
      const where = conditions.join(' AND ');
      params.push(limit + 1);
      const rows = db
        .query<{
          userId: string;
          roles: string;
          createdAt: number;
        }>(
          `SELECT userId, roles, createdAt FROM group_memberships WHERE ${where} ORDER BY createdAt ASC, userId ASC LIMIT ?`,
        )
        .all(...params);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? encodeCursor({
            createdAt: page[page.length - 1].createdAt,
            id: page[page.length - 1].userId,
          })
        : undefined;
      return {
        items: page.map(r => ({ userId: r.userId, roles: JSON.parse(r.roles) as string[] })),
        nextCursor,
        hasMore: !!nextCursor,
      };
    },

    async getUserGroups(userId, tenantId) {
      type MemberRow = { groupId: string; memberRoles: string };
      let memberRows: MemberRow[];
      if (tenantId === null) {
        memberRows = db
          .query<MemberRow>(
            'SELECT groupId, roles as memberRoles FROM group_memberships WHERE userId = ? AND tenantId IS NULL',
          )
          .all(userId);
      } else {
        memberRows = db
          .query<MemberRow>(
            'SELECT groupId, roles as memberRoles FROM group_memberships WHERE userId = ? AND tenantId = ?',
          )
          .all(userId, tenantId);
      }
      if (memberRows.length === 0) return [];
      const result: Array<{ group: GroupRecord; membershipRoles: string[] }> = [];
      for (const m of memberRows) {
        const row = db
          .query<{
            id: string;
            name: string;
            displayName: string | null;
            description: string | null;
            roles: string;
            tenantId: string | null;
            createdAt: number;
            updatedAt: number;
          }>(
            'SELECT id, name, displayName, description, roles, tenantId, createdAt, updatedAt FROM groups WHERE id = ?',
          )
          .get(m.groupId);
        if (row) {
          result.push({
            group: {
              ...row,
              displayName: row.displayName ?? undefined,
              description: row.description ?? undefined,
              roles: JSON.parse(row.roles) as string[],
            },
            membershipRoles: JSON.parse(m.memberRoles) as string[],
          });
        }
      }
      return result;
    },

    async getEffectiveRoles(userId, tenantId) {
      // Direct roles
      let direct: string[];
      if (tenantId) {
        const rows = db
          .query<{
            role: string;
          }>('SELECT role FROM tenant_roles WHERE userId = ? AND tenantId = ?')
          .all(userId, tenantId);
        direct = rows.map(r => r.role);
      } else {
        const row = db.query<{ roles: string }>('SELECT roles FROM users WHERE id = ?').get(userId);
        direct = row ? (JSON.parse(row.roles) as string[]) : [];
      }
      // Group roles via memberships
      type MemberRow = { groupRoles: string; memberRoles: string };
      let memberRows: MemberRow[];
      if (tenantId === null) {
        memberRows = db
          .query<MemberRow>(
            'SELECT g.roles as groupRoles, gm.roles as memberRoles FROM group_memberships gm JOIN groups g ON g.id = gm.groupId WHERE gm.userId = ? AND gm.tenantId IS NULL',
          )
          .all(userId);
      } else {
        memberRows = db
          .query<MemberRow>(
            'SELECT g.roles as groupRoles, gm.roles as memberRoles FROM group_memberships gm JOIN groups g ON g.id = gm.groupId WHERE gm.userId = ? AND gm.tenantId = ?',
          )
          .all(userId, tenantId);
      }
      const groupRoles = memberRows.flatMap(r => [
        ...(JSON.parse(r.groupRoles) as string[]),
        ...(JSON.parse(r.memberRoles) as string[]),
      ]);
      return [...new Set([...direct, ...groupRoles])];
    },

    async getM2MClient(clientId: string) {
      const row = db
        .query<{
          id: string;
          clientId: string;
          clientSecretHash: string;
          name: string;
          scopes: string;
          active: number;
        }>(
          'SELECT id, clientId, clientSecretHash, name, scopes, active FROM m2m_clients WHERE clientId = ? AND active = 1',
        )
        .get(clientId);
      if (!row) return null;
      return {
        id: row.id,
        clientId: row.clientId,
        clientSecretHash: row.clientSecretHash,
        name: row.name,
        scopes: JSON.parse(row.scopes) as string[],
        active: row.active === 1,
      };
    },

    async createM2MClient(data: {
      clientId: string;
      clientSecretHash: string;
      name: string;
      scopes: string[];
    }) {
      const id = crypto.randomUUID();
      db.run(
        'INSERT INTO m2m_clients (id, clientId, clientSecretHash, name, scopes, active, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [
          id,
          data.clientId,
          data.clientSecretHash,
          data.name,
          JSON.stringify(data.scopes),
          Date.now(),
        ],
      );
      return { id };
    },

    async deleteM2MClient(clientId: string) {
      db.run('DELETE FROM m2m_clients WHERE clientId = ?', [clientId]);
    },

    async listM2MClients() {
      const rows = db
        .query<{
          id: string;
          clientId: string;
          name: string;
          scopes: string;
          active: number;
        }>('SELECT id, clientId, name, scopes, active FROM m2m_clients')
        .all();
      return rows.map(row => ({
        id: row.id,
        clientId: row.clientId,
        name: row.name,
        scopes: JSON.parse(row.scopes) as string[],
        active: row.active === 1,
      }));
    },
  };

  // ---------------------------------------------------------------------------
  // Session helpers
  // ---------------------------------------------------------------------------

  function deleteSessionImpl(sessionId: string, getConfig: () => AuthResolvedConfig): void {
    if (getConfig().persistSessionMetadata) {
      db.run(
        'UPDATE sessions SET token = NULL, refreshToken = NULL, prevRefreshToken = NULL, prevTokenExpiresAt = NULL WHERE sessionId = ?',
        [sessionId],
      );
    } else {
      db.run('DELETE FROM sessions WHERE sessionId = ?', [sessionId]);
    }
  }

  const OAUTH_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  interface UploadRecordRow {
    key: string;
    ownerUserId: string | null;
    tenantId: string | null;
    mimeType: string | null;
    bucket: string | null;
    createdAt: number;
  }

  const result: SqliteAuthResult = {
    db,
    adapter,
    cleanupInterval: null,

    atomicCreateSession(userId, token, sessionId, maxSessions, getConfig, metadata?) {
      const now = Date.now();
      const ttlMs = getSessionTtlMs(getConfig);
      const expiresAt = now + ttlMs;

      db.transaction(() => {
        const countRow = db
          .query<{
            count: number;
          }>(
            'SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ?',
          )
          .get(userId, now);
        let activeCount = countRow?.count ?? 0;

        while (activeCount >= maxSessions) {
          const oldest = db
            .query<{
              sessionId: string;
            }>(
              'SELECT sessionId FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ? ORDER BY createdAt ASC LIMIT 1',
            )
            .get(userId, now);
          if (!oldest) break;
          if (getConfig().persistSessionMetadata) {
            db.run(
              'UPDATE sessions SET token = NULL, refreshToken = NULL, prevRefreshToken = NULL, prevTokenExpiresAt = NULL WHERE sessionId = ?',
              [oldest.sessionId],
            );
          } else {
            db.run('DELETE FROM sessions WHERE sessionId = ?', [oldest.sessionId]);
          }
          activeCount--;
        }

        db.run(
          'INSERT INTO sessions (sessionId, userId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            sessionId,
            userId,
            token,
            now,
            now,
            expiresAt,
            metadata?.ipAddress ?? null,
            metadata?.userAgent ?? null,
          ],
        );
      })();
    },

    createSession(userId, token, sessionId, getConfig, metadata?) {
      const now = Date.now();
      const expiresAt = now + getSessionTtlMs(getConfig);
      db.run(
        'INSERT INTO sessions (sessionId, userId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          sessionId,
          userId,
          token,
          now,
          now,
          expiresAt,
          metadata?.ipAddress ?? null,
          metadata?.userAgent ?? null,
        ],
      );
    },

    getSession(sessionId) {
      const row = db
        .query<{
          token: string | null;
        }>('SELECT token FROM sessions WHERE sessionId = ? AND expiresAt > ?')
        .get(sessionId, Date.now());
      if (!row || !row.token) return null;
      return row.token;
    },

    getSessionRecord(sessionId) {
      const row = db
        .query<{
          token: string | null;
          lastActiveAt: number;
        }>('SELECT token, lastActiveAt FROM sessions WHERE sessionId = ? AND expiresAt > ?')
        .get(sessionId, Date.now());
      if (!row || !row.token) return null;
      return { token: row.token, lastActiveAt: row.lastActiveAt };
    },

    deleteSession: deleteSessionImpl,

    getUserSessions(userId, getConfig) {
      const now = Date.now();
      const rows = db
        .query<{
          sessionId: string;
          createdAt: number;
          lastActiveAt: number;
          expiresAt: number;
          token: string | null;
          ipAddress: string | null;
          userAgent: string | null;
        }>(
          'SELECT sessionId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent FROM sessions WHERE userId = ? ORDER BY createdAt ASC',
        )
        .all(userId);

      const cfg = getConfig();
      const includeInactive = cfg.includeInactiveSessions;
      const persist = cfg.persistSessionMetadata;
      const results: SessionInfo[] = [];
      for (const row of rows) {
        const isActive = !!row.token && row.expiresAt > now;
        if (!isActive && !persist) continue;
        if (!isActive && !includeInactive) continue;
        results.push({
          sessionId: row.sessionId,
          createdAt: row.createdAt,
          lastActiveAt: row.lastActiveAt,
          expiresAt: row.expiresAt,
          ipAddress: row.ipAddress ?? undefined,
          userAgent: row.userAgent ?? undefined,
          isActive,
        });
      }
      return results;
    },

    getActiveSessionCount(userId) {
      const row = db
        .query<{
          count: number;
        }>(
          'SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ?',
        )
        .get(userId, Date.now());
      return row?.count ?? 0;
    },

    evictOldestSession(userId, getConfig) {
      const now = Date.now();
      const oldest = db
        .query<{
          sessionId: string;
        }>(
          'SELECT sessionId FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ? ORDER BY createdAt ASC LIMIT 1',
        )
        .get(userId, now);
      if (oldest) deleteSessionImpl(oldest.sessionId, getConfig);
    },

    updateSessionLastActive(sessionId) {
      db.run('UPDATE sessions SET lastActiveAt = ? WHERE sessionId = ?', [Date.now(), sessionId]);
    },

    setRefreshToken(sessionId, refreshToken) {
      const tokenHash = hashToken(refreshToken);
      db.run('UPDATE sessions SET refreshToken = ? WHERE sessionId = ?', [tokenHash, sessionId]);
    },

    getSessionByRefreshToken(refreshToken, getConfig) {
      const tokenHash = hashToken(refreshToken);

      // Check current refresh token (stored as hash)
      const row = db
        .query<{
          sessionId: string;
          userId: string;
          refreshToken: string | null;
        }>('SELECT sessionId, userId, refreshToken FROM sessions WHERE refreshToken = ?')
        .get(tokenHash);
      if (row) {
        return {
          sessionId: row.sessionId,
          userId: row.userId,
          fromGrace: false,
        };
      }

      // Check previous refresh token hash (grace window)
      interface GraceWindowRow {
        sessionId: string;
        userId: string;
        prevTokenExpiresAt: number | null;
      }
      const graceRow = db
        .query<GraceWindowRow>(
          'SELECT sessionId, userId, prevTokenExpiresAt FROM sessions WHERE prevRefreshToken = ?',
        )
        .get(tokenHash);
      if (!graceRow) return null;

      if (graceRow.prevTokenExpiresAt && graceRow.prevTokenExpiresAt > Date.now()) {
        return {
          sessionId: graceRow.sessionId,
          userId: graceRow.userId,
          fromGrace: true,
        };
      }

      // Grace window expired — theft detected, invalidate session
      deleteSessionImpl(graceRow.sessionId, getConfig);
      return null;
    },

    rotateRefreshToken(sessionId, newRefreshToken, newAccessToken, getConfig) {
      const graceSeconds = getConfig().refreshToken?.rotationGraceSeconds ?? 10;
      const prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      const newHash = hashToken(newRefreshToken);
      db.run(
        'UPDATE sessions SET prevRefreshToken = refreshToken, prevTokenExpiresAt = ?, refreshToken = ?, token = ? WHERE sessionId = ?',
        [prevTokenExpiresAt, newHash, newAccessToken, sessionId],
      );
    },

    getSessionFingerprint(sessionId) {
      const row = db
        .query<{
          fingerprint: string | null;
        }>('SELECT fingerprint FROM sessions WHERE sessionId = ?')
        .get(sessionId);
      return row?.fingerprint ?? null;
    },

    setSessionFingerprint(sessionId, fingerprint) {
      db.run('UPDATE sessions SET fingerprint = ? WHERE sessionId = ?', [fingerprint, sessionId]);
    },

    getMfaVerifiedAt(sessionId) {
      const row = db
        .query<{
          mfaVerifiedAt: number | null;
        }>('SELECT mfaVerifiedAt FROM sessions WHERE sessionId = ?')
        .get(sessionId);
      return row?.mfaVerifiedAt ?? null;
    },

    setMfaVerifiedAt(sessionId, ts) {
      db.run('UPDATE sessions SET mfaVerifiedAt = ? WHERE sessionId = ?', [ts, sessionId]);
    },

    storeOAuthState(state, codeVerifier?, linkUserId?) {
      const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
      db.run(
        'INSERT INTO oauth_states (state, codeVerifier, linkUserId, expiresAt) VALUES (?, ?, ?, ?)',
        [state, codeVerifier ?? null, linkUserId ?? null, expiresAt],
      );
    },

    consumeOAuthState(state) {
      const row = db
        .query<{
          codeVerifier: string | null;
          linkUserId: string | null;
        }>(
          'DELETE FROM oauth_states WHERE state = ? AND expiresAt > ? RETURNING codeVerifier, linkUserId',
        )
        .get(state, Date.now());
      if (!row) return null;
      return {
        codeVerifier: row.codeVerifier ?? undefined,
        linkUserId: row.linkUserId ?? undefined,
      };
    },

    getCache(key) {
      const row = db
        .query<{
          value: string;
        }>('SELECT value FROM cache_entries WHERE key = ? AND (expiresAt IS NULL OR expiresAt > ?)')
        .get(key, Date.now());
      return row?.value ?? null;
    },

    setCache(key, value, ttlSeconds?) {
      const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
      db.run(
        'INSERT INTO cache_entries (key, value, expiresAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt',
        [key, value, expiresAt],
      );
    },

    delCache(key) {
      db.run('DELETE FROM cache_entries WHERE key = ?', [key]);
    },

    delCachePattern(pattern) {
      // Convert glob pattern (* wildcard) to a SQL LIKE pattern (% wildcard)
      const likePattern = pattern.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%');
      db.run("DELETE FROM cache_entries WHERE key LIKE ? ESCAPE '\\'", [likePattern]);
    },

    createVerificationToken(token, userId, email, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run(
        'INSERT INTO email_verifications (token, userId, email, expiresAt) VALUES (?, ?, ?, ?)',
        [token, userId, email, expiresAt],
      );
    },

    getVerificationToken(token) {
      const row = db
        .query<{
          userId: string;
          email: string;
        }>('SELECT userId, email FROM email_verifications WHERE token = ? AND expiresAt > ?')
        .get(token, Date.now());
      return row ?? null;
    },

    deleteVerificationToken(token) {
      db.run('DELETE FROM email_verifications WHERE token = ?', [token]);
    },

    consumeVerificationToken(token) {
      const row = db
        .query<{
          userId: string;
          email: string;
        }>(
          'DELETE FROM email_verifications WHERE token = ? AND expiresAt > ? RETURNING userId, email',
        )
        .get(token, Date.now());
      return row ?? null;
    },

    createResetToken(token, userId, email, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run('INSERT INTO password_resets (token, userId, email, expiresAt) VALUES (?, ?, ?, ?)', [
        token,
        userId,
        email,
        expiresAt,
      ]);
    },

    consumeResetToken(hash) {
      const row = db
        .query<{
          userId: string;
          email: string;
        }>('DELETE FROM password_resets WHERE token = ? AND expiresAt > ? RETURNING userId, email')
        .get(hash, Date.now());
      return row ?? null;
    },

    createDeletionCancelToken(token, userId, jobId, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run(
        'INSERT INTO deletion_cancel_tokens (token, userId, jobId, expiresAt) VALUES (?, ?, ?, ?)',
        [token, userId, jobId, expiresAt],
      );
    },

    consumeDeletionCancelToken(hash) {
      const row = db
        .query<{
          userId: string;
          jobId: string;
        }>(
          'DELETE FROM deletion_cancel_tokens WHERE token = ? AND expiresAt > ? RETURNING userId, jobId',
        )
        .get(hash, Date.now());
      return row ?? null;
    },

    storeOAuthCode(hash, payload, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run(
        'INSERT INTO oauth_codes (codeHash, token, userId, email, refreshToken, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
        [
          hash,
          payload.token,
          payload.userId,
          payload.email ?? null,
          payload.refreshToken ?? null,
          expiresAt,
        ],
      );
    },

    consumeOAuthCode(hash) {
      const row = db
        .query<{
          token: string;
          userId: string;
          email: string | null;
          refreshToken: string | null;
        }>(
          'DELETE FROM oauth_codes WHERE codeHash = ? AND expiresAt > ? RETURNING token, userId, email, refreshToken',
        )
        .get(hash, Date.now());
      if (!row) return null;
      return {
        token: row.token,
        userId: row.userId,
        email: row.email ?? undefined,
        refreshToken: row.refreshToken ?? undefined,
      };
    },

    storeOAuthReauth(hash, data, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run(
        'INSERT INTO oauth_reauth_states (tokenHash, userId, sessionId, provider, purpose, returnUrl, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          hash,
          data.userId,
          data.sessionId,
          data.provider,
          data.purpose,
          data.returnUrl ?? null,
          expiresAt,
        ],
      );
    },

    consumeOAuthReauth(hash) {
      const row = db
        .query<{
          userId: string;
          sessionId: string;
          provider: string;
          purpose: string;
          returnUrl: string | null;
          expiresAt: number;
        }>(
          'DELETE FROM oauth_reauth_states WHERE tokenHash = ? AND expiresAt > ? RETURNING userId, sessionId, provider, purpose, returnUrl, expiresAt',
        )
        .get(hash, Date.now());
      if (!row) return null;
      return {
        userId: row.userId,
        sessionId: row.sessionId,
        provider: row.provider,
        purpose: row.purpose,
        expiresAt: row.expiresAt,
        returnUrl: row.returnUrl ?? undefined,
      };
    },

    storeOAuthReauthConfirmation(hash, data, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run(
        'INSERT INTO oauth_reauth_confirmations (codeHash, userId, sessionId, purpose, expiresAt) VALUES (?, ?, ?, ?, ?)',
        [hash, data.userId, data.sessionId, data.purpose, expiresAt],
      );
    },

    consumeOAuthReauthConfirmation(hash) {
      const row = db
        .query<{
          userId: string;
          sessionId: string;
          purpose: string;
        }>(
          'DELETE FROM oauth_reauth_confirmations WHERE codeHash = ? AND expiresAt > ? RETURNING userId, sessionId, purpose',
        )
        .get(hash, Date.now());
      if (!row) return null;
      return { userId: row.userId, sessionId: row.sessionId, purpose: row.purpose };
    },

    registerUpload(record) {
      db.run(
        `INSERT OR REPLACE INTO upload_registry (key, ownerUserId, tenantId, mimeType, bucket, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          record.key,
          record.ownerUserId ?? null,
          record.tenantId ?? null,
          record.mimeType ?? null,
          record.bucket ?? null,
          record.createdAt,
        ],
      );
    },

    getUploadRecord(key) {
      const row = db
        .query<UploadRecordRow>(
          'SELECT key, ownerUserId, tenantId, mimeType, bucket, createdAt FROM upload_registry WHERE key = ?',
        )
        .get(key);
      if (!row) return null;
      return {
        key: row.key,
        ...(row.ownerUserId !== null ? { ownerUserId: row.ownerUserId } : {}),
        ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
        ...(row.mimeType !== null ? { mimeType: row.mimeType } : {}),
        ...(row.bucket !== null ? { bucket: row.bucket } : {}),
        createdAt: row.createdAt,
      };
    },

    deleteUploadRecord(key) {
      // Use prepare().run() to get a RuntimeSqliteRunResult with .changes
      const r = db.prepare('DELETE FROM upload_registry WHERE key = ?').run(key);
      return r.changes > 0;
    },

    createMagicLinkToken(token, userId, ttlSeconds) {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.run('INSERT INTO magic_link_tokens (token, userId, expiresAt) VALUES (?, ?, ?)', [
        token,
        userId,
        expiresAt,
      ]);
    },

    consumeMagicLinkToken(hash) {
      const row = db
        .query<{
          userId: string;
        }>('DELETE FROM magic_link_tokens WHERE token = ? AND expiresAt > ? RETURNING userId')
        .get(hash, Date.now());
      return row?.userId ?? null;
    },

    startCleanup(getConfig, intervalMs = 3_600_000) {
      // Clear any existing interval to prevent duplicates
      if (_cleanupInterval !== null) {
        clearInterval(_cleanupInterval);
      }
      runCleanup(getConfig);
      const handle = setInterval(() => {
        runCleanup(getConfig);
      }, intervalMs);
      _cleanupInterval = handle;
      result.cleanupInterval = handle;
      return handle;
    },

    stopCleanup() {
      if (_cleanupInterval !== null) {
        clearInterval(_cleanupInterval);
        _cleanupInterval = null;
        result.cleanupInterval = null;
      }
    },
  };

  return result;
}

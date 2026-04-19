 
import {
  DEFAULT_MAX_ENTRIES,
  createEvictExpired,
  evictOldest,
  sha256,
  timingSafeEqual,
} from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import { isSqliteDuplicateColumnError } from './sqliteSchemaErrors';
import { createSqliteInitializer } from './sqliteInit';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminator for the purpose of an MFA challenge.
 *
 * - `'login'` — second factor required to complete a password-based login. Created by the
 *   login route after the first factor passes; consumed by `POST /auth/mfa/verify`.
 * - `'webauthn-registration'` — WebAuthn registration challenge. Created by
 *   `POST /auth/webauthn/register/begin`; consumed by `POST /auth/webauthn/register/complete`.
 * - `'passkey-login'` — Passkey (platform authenticator) login challenge with no pre-existing
 *   `userId` (discoverable credential flow). Created by `POST /auth/webauthn/login/begin`;
 *   consumed by `POST /auth/webauthn/login/complete`.
 * - `'reauth'` — Re-authentication challenge for step-up flows or privileged actions.
 *   Tied to a specific `sessionId` to prevent cross-session replay. Created by step-up
 *   routes; consumed by `POST /auth/step-up/verify`.
 */
export type MfaChallengePurpose = 'login' | 'webauthn-registration' | 'passkey-login' | 'reauth';

/**
 * Optional second-factor material to embed in an MFA challenge at creation time.
 *
 * Pass at most one of these — a challenge is either email-OTP-based or WebAuthn-based,
 * not both simultaneously.
 */
export interface MfaChallengeOptions {
  /** SHA-256 hash of the email OTP code that was sent to the user. */
  emailOtpHash?: string;
  /** Base64url-encoded WebAuthn challenge bytes. */
  webauthnChallenge?: string;
}

/**
 * Options for creating a re-authentication MFA challenge.
 *
 * Extends the base challenge options with a TTL override so callers can shorten the
 * challenge lifetime for time-sensitive step-up flows.
 */
export interface ReauthChallengeOptions {
  /** SHA-256 hash of the email OTP sent for this re-auth challenge. */
  emailOtpHash?: string;
  /** Base64url-encoded WebAuthn challenge bytes. */
  webauthnChallenge?: string;
  /**
   * Custom TTL in seconds for this challenge. Overrides
   * `auth.mfa.challengeTtlSeconds`. Useful for tightly scoped step-up flows.
   */
  ttlSeconds?: number;
}

/**
 * Resolved MFA challenge data returned after consuming a challenge token.
 *
 * Returned by `consumeMfaChallenge`, `consumeReauthChallenge`, etc. Contains enough
 * information for the verifier to check the submitted second factor.
 */
export interface MfaChallengeData {
  /** The user ID that initiated the MFA challenge. */
  userId: string;
  /** The purpose that this challenge was created for. */
  purpose: MfaChallengePurpose;
  /** SHA-256 hash of the email OTP that was sent. Present only for email-OTP challenges. */
  emailOtpHash?: string;
  /** Base64url-encoded WebAuthn challenge bytes. Present only for WebAuthn challenges. */
  webauthnChallenge?: string;
  /** Session ID bound to this challenge. Present only for `'reauth'` purpose challenges. */
  sessionId?: string;
}

interface MfaChallengeRecord {
  userId: string;
  purpose: MfaChallengePurpose;
  emailOtpHash?: string;
  webauthnChallenge?: string;
  sessionId?: string;
  createdAt: number;
  resendCount: number;
}

const MAX_RESENDS = 3;

function addColumnIfMissing(db: RuntimeSqliteDatabase, sql: string, column: string): void {
  try {
    db.run(sql);
  } catch (err) {
    if (isSqliteDuplicateColumnError(err, column)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for MFA challenge state.
 *
 * An MFA challenge is created when a user successfully passes the first factor but needs
 * to complete a second factor (TOTP, email OTP, WebAuthn). The challenge token is returned
 * to the client and presented back with the second-factor code.
 *
 * Challenges have a configurable TTL (`auth.mfa.challengeTtlSeconds`, default 300s) and
 * allow limited resends (max 3) for email OTP before requiring a new challenge.
 *
 * @remarks
 * **Resend limit**: each challenge tracks a `resendCount`. When `replaceOtp` is called,
 * the counter is incremented. Once `resendCount >= 3` (the `MAX_RESENDS` constant),
 * `replaceOtp` returns `null` without updating the challenge, forcing the client to
 * initiate a new login attempt. This prevents OTP enumeration via unlimited resends.
 *
 * The resend window also caps the challenge's extension: `expiresAt` is capped at
 * `createdAt + ttl * 3` so a series of resends cannot extend the challenge indefinitely.
 */
export interface MfaChallengeRepository {
  /**
   * Stores a new MFA challenge record identified by `hash`.
   *
   * @param hash - SHA-256 hex digest of the plain-text challenge token. Used as the storage key.
   * @param data - Challenge payload (userId, purpose, optional OTP hash / WebAuthn challenge, etc.).
   * @param ttl - Challenge lifetime in **seconds**. Derived from `auth.mfa.challengeTtlSeconds`
   *   (default 300 s). Backends apply this as a Redis `EX`, a SQLite `expiresAt`, or a Mongoose
   *   TTL index entry.
   *
   * @remarks
   * The challenge token itself is never stored — only its SHA-256 hash is persisted so that a
   * database leak does not expose valid tokens. The plain token is returned once to the caller
   * and sent to the client; it must be re-hashed on lookup.
   *
   * A maximum of 3 resends (`MAX_RESENDS`) is enforced by `replaceOtp`. The `resendCount` field
   * in `data` should be `0` for newly created challenges.
   */
  createChallenge(hash: string, data: MfaChallengeRecord, ttl: number): Promise<void>;

  /**
   * Atomically reads and deletes the challenge identified by `hash`.
   *
   * @param hash - SHA-256 hex digest of the token presented by the client.
   * @returns The `MfaChallengeRecord` if the challenge exists and has not expired; `null` otherwise.
   *
   * @remarks
   * **Atomic single-use consumption**: all backends implement read-and-delete atomically
   * (Redis `GETDEL` / Lua fallback, SQLite `DELETE ... RETURNING`, Postgres
   * `DELETE ... RETURNING`, MongoDB `findOneAndDelete`). Once consumed a token is gone —
   * retrying the same token returns `null`. This prevents double-verification attacks where
   * an attacker replays a valid OTP after it has already been accepted.
   *
   * Returns `null` for **any** of: challenge not found, challenge expired, or challenge
   * already consumed. Callers cannot distinguish these cases, which is intentional.
   */
  consumeChallenge(hash: string): Promise<MfaChallengeRecord | null>;

  /**
   * Replaces the OTP hash in an existing challenge and increments its resend counter.
   *
   * @param hash - SHA-256 hex digest of the challenge token whose OTP should be refreshed.
   * @param newOtpHash - SHA-256 hash of the newly generated OTP to store.
   * @param ttl - Base TTL in seconds (from `auth.mfa.challengeTtlSeconds`). Used to compute
   *   the new `expiresAt` (capped at `createdAt + ttl * 3` to limit total challenge lifetime).
   * @param maxResends - Maximum number of resends allowed (the `MAX_RESENDS` constant, value 3).
   * @returns `{ userId, resendCount }` on success, or `null` when the challenge is not found,
   *   expired, or has already reached the resend limit.
   *
   * @remarks
   * **Resend limit enforcement**: when `resendCount >= maxResends` (i.e., 3 resends have
   * already been issued), this method returns `null` without modifying the challenge. The
   * caller must treat `null` as a hard failure and instruct the client to restart the login
   * flow entirely. This prevents OTP enumeration via unlimited resend loops.
   *
   * **Expiry cap**: even after a successful resend the new `expiresAt` is capped at
   * `createdAt + ttl * 3`. A series of rapid resends cannot extend the challenge
   * indefinitely — the window is always bounded by the original creation time.
   */
  replaceOtp(
    hash: string,
    newOtpHash: string,
    ttl: number,
    maxResends: number,
  ): Promise<{ userId: string; resendCount: number } | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory MFA challenge repository.
 *
 * Stores challenges in a `Map` with opportunistic expiry sweep. Each call returns an
 * independent instance with its own closure-owned state. Suitable for testing.
 *
 * @returns A `MfaChallengeRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryMfaChallengeRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const mfaRepo = createMemoryMfaChallengeRepository();
 */
export function createMemoryMfaChallengeRepository(): MfaChallengeRepository {
  const challenges = new Map<string, MfaChallengeRecord & { expiresAt: number }>();
  const evictExpired = createEvictExpired();

  return {
    async createChallenge(hash, data, ttl) {
      evictExpired(challenges);
      evictOldest(challenges, DEFAULT_MAX_ENTRIES);
      challenges.set(hash, { ...data, expiresAt: Date.now() + ttl * 1000 });
    },

    async consumeChallenge(hash) {
      const entry = challenges.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        challenges.delete(hash);
        return null;
      }
      challenges.delete(hash);
      return {
        userId: entry.userId,
        purpose: entry.purpose,
        emailOtpHash: entry.emailOtpHash,
        webauthnChallenge: entry.webauthnChallenge,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        resendCount: entry.resendCount,
      };
    },

    async replaceOtp(hash, newOtpHash, ttl, maxResends) {
      const entry = challenges.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        challenges.delete(hash);
        return null;
      }
      if (entry.resendCount >= maxResends) return null;
      entry.emailOtpHash = newOtpHash;
      entry.resendCount++;
      const maxExpiry = entry.createdAt + ttl * 3 * 1000;
      entry.expiresAt = Math.min(Date.now() + ttl * 1000, maxExpiry);
      return { userId: entry.userId, resendCount: entry.resendCount };
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed MFA challenge repository.
 *
 * The `mfa_challenges` table is created on first use and migrated incrementally
 * to add newer columns (`emailOtpHash`, `createdAt`, `resendCount`, `purpose`,
 * `webauthnChallenge`, `sessionId`) when upgrading an existing database. Each
 * migration step is wrapped in a try/catch so the migration is idempotent.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `MfaChallengeRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method. Subsequent calls
 * skip initialisation via a closure-owned `tableCreated` flag.
 *
 * @example
 * import { createSqliteMfaChallengeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const mfaRepo = createSqliteMfaChallengeRepository(db);
 */
export function createSqliteMfaChallengeRepository(
  db: RuntimeSqliteDatabase,
): MfaChallengeRepository {
  const ensureTable = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS mfa_challenges (
      token             TEXT PRIMARY KEY,
      userId            TEXT NOT NULL,
      purpose           TEXT NOT NULL DEFAULT 'login',
      emailOtpHash      TEXT,
      webauthnChallenge TEXT,
      sessionId         TEXT,
      createdAt         INTEGER NOT NULL,
      resendCount       INTEGER NOT NULL DEFAULT 0,
      expiresAt         INTEGER NOT NULL
    )`);
    // Migrate pre-existing tables that lack newer columns
    addColumnIfMissing(db, 'ALTER TABLE mfa_challenges ADD COLUMN emailOtpHash TEXT', 'emailOtpHash');
    addColumnIfMissing(
      db,
      'ALTER TABLE mfa_challenges ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0',
      'createdAt',
    );
    addColumnIfMissing(
      db,
      'ALTER TABLE mfa_challenges ADD COLUMN resendCount INTEGER NOT NULL DEFAULT 0',
      'resendCount',
    );
    addColumnIfMissing(
      db,
      "ALTER TABLE mfa_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'",
      'purpose',
    );
    addColumnIfMissing(
      db,
      'ALTER TABLE mfa_challenges ADD COLUMN webauthnChallenge TEXT',
      'webauthnChallenge',
    );
    addColumnIfMissing(db, 'ALTER TABLE mfa_challenges ADD COLUMN sessionId TEXT', 'sessionId');
  });

  return {
    async createChallenge(hash, data, ttl) {
      ensureTable();
      const now = Date.now();
      db.run(
        'INSERT INTO mfa_challenges (token, userId, purpose, emailOtpHash, webauthnChallenge, sessionId, createdAt, resendCount, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        hash,
        data.userId,
        data.purpose,
        data.emailOtpHash ?? null,
        data.webauthnChallenge ?? null,
        data.sessionId ?? null,
        data.createdAt,
        data.resendCount,
        now + ttl * 1000,
      );
    },

    async consumeChallenge(hash) {
      ensureTable();
      const row = db
        .query(
          'DELETE FROM mfa_challenges WHERE token = ? AND expiresAt > ? RETURNING userId, purpose, emailOtpHash, webauthnChallenge, sessionId, createdAt, resendCount',
        )
        .get(hash, Date.now()) as {
        userId: string;
        purpose: string;
        emailOtpHash: string | null;
        webauthnChallenge: string | null;
        sessionId: string | null;
        createdAt: number;
        resendCount: number;
      } | null;
      if (!row) return null;
      return {
        userId: row.userId,
        purpose: row.purpose as MfaChallengePurpose,
        emailOtpHash: row.emailOtpHash ?? undefined,
        webauthnChallenge: row.webauthnChallenge ?? undefined,
        sessionId: row.sessionId ?? undefined,
        createdAt: row.createdAt,
        resendCount: row.resendCount,
      };
    },

    async replaceOtp(hash, newOtpHash, ttl, maxResends) {
      ensureTable();
      const now = Date.now();
      const existing = db
        .query(
          'SELECT createdAt, resendCount FROM mfa_challenges WHERE token = ? AND expiresAt > ?',
        )
        .get(hash, now) as { createdAt: number; resendCount: number } | null;
      if (!existing || existing.resendCount >= maxResends) return null;
      const newExpiry = Math.min(now + ttl * 1000, existing.createdAt + ttl * 3 * 1000);
      const newCount = existing.resendCount + 1;
      const row = db
        .query(
          'UPDATE mfa_challenges SET emailOtpHash = ?, resendCount = ?, expiresAt = ? WHERE token = ? RETURNING userId',
        )
        .get(newOtpHash, newCount, newExpiry, hash) as { userId: string } | null;
      return row ? { userId: row.userId, resendCount: newCount } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/** Atomically GET+DEL a key. Uses native GETDEL (Redis >= 6.2) with a Lua fallback. */
async function redisGetDel(redis: RedisLike, key: string): Promise<string | null> {
  if (typeof redis.getdel === 'function') {
    try {
      return await redis.getdel(key);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (!/unknown command|ERR unknown command/i.test(msg)) throw err;
      // Fall through to Lua on "unknown command"
    }
  }
  const result = await redis.eval(
    "local v = redis.call('GET', KEYS[1])\nif v then redis.call('DEL', KEYS[1]) end\nreturn v",
    1,
    key,
  );
  return (result as string | null) ?? null;
}

/**
 * Creates a Redis-backed MFA challenge repository.
 *
 * Keys are namespaced as `mfachallenge:<appName>:<hash>` and stored as JSON with a
 * Redis `EX` TTL. `consumeChallenge` uses an atomic `GETDEL` (Redis >= 6.2) with a
 * Lua fallback for older Redis versions to prevent double-consumption. The `replaceOtp`
 * method uses a Lua script to atomically read, validate the resend count, update the
 * OTP hash, and extend the TTL — all in a single round-trip.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `MfaChallengeRepository` backed by Redis.
 *
 * @example
 * import { createRedisMfaChallengeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const mfaRepo = createRedisMfaChallengeRepository(() => redisClient, 'my-app');
 */
export function createRedisMfaChallengeRepository(
  getRedis: () => RedisLike,
  appName: string,
): MfaChallengeRepository {
  return {
    async createChallenge(hash, data, ttl) {
      const redis = getRedis();
      await redis.set(`mfachallenge:${appName}:${hash}`, JSON.stringify(data), 'EX', ttl);
    },

    async consumeChallenge(hash) {
      const redis = getRedis();
      const key = `mfachallenge:${appName}:${hash}`;
      const raw = await redisGetDel(redis, key);
      if (!raw) return null;
      return JSON.parse(raw) as MfaChallengeRecord;
    },

    async replaceOtp(hash, newOtpHash, ttl, maxResends) {
      const redis = getRedis();
      const key = `mfachallenge:${appName}:${hash}`;
      const now = Date.now();
      const luaScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local data = cjson.decode(raw)
if data.resendCount >= tonumber(ARGV[1]) then return nil end
data.emailOtpHash = ARGV[2]
data.resendCount = data.resendCount + 1
local maxExpiry = data.createdAt + tonumber(ARGV[3]) * 3 * 1000
local nowTtl = tonumber(ARGV[4]) + tonumber(ARGV[3]) * 1000
local newExpiry = math.min(nowTtl, maxExpiry)
local remainingTtl = math.max(1, math.ceil((newExpiry - tonumber(ARGV[4])) / 1000))
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', remainingTtl)
return cjson.encode({ userId = data.userId, resendCount = data.resendCount })
`;
      const result = (await redis.eval(luaScript, 1, key, maxResends, newOtpHash, ttl, now)) as
        | string
        | null;
      if (!result) return null;
      return JSON.parse(result) as { userId: string; resendCount: number };
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface MfaChallengeDoc {
  token: string;
  userId: string;
  purpose: string;
  emailOtpHash?: string;
  webauthnChallenge?: string;
  sessionId?: string;
  createdAt: Date;
  resendCount: number;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed MFA challenge repository.
 *
 * Registers (or retrieves a cached) `MfaChallenge` Mongoose model on the provided connection.
 * Documents expire via a MongoDB TTL index on `expiresAt`. `consumeChallenge` uses
 * `findOneAndDelete` for atomic read-and-delete. `replaceOtp` uses MongoDB aggregation
 * pipeline update syntax to compute the new `expiresAt` cap server-side.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `MfaChallengeRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `mfa_challenges` is auto-created on the first write.
 *
 * @example
 * import { createMongoMfaChallengeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const mfaRepo = createMongoMfaChallengeRepository(conn, mongoose);
 */
export function createMongoMfaChallengeRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): MfaChallengeRepository {
  function getModel(): import('mongoose').Model<MfaChallengeDoc> {
    if ('MfaChallenge' in conn.models)
      return conn.models['MfaChallenge'] as unknown as import('mongoose').Model<MfaChallengeDoc>;
    const { Schema } = mg;
    const schema = new Schema<MfaChallengeDoc>(
      {
        token: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        purpose: { type: String, required: true, default: 'login' },
        emailOtpHash: { type: String },
        webauthnChallenge: { type: String },
        sessionId: { type: String },
        createdAt: { type: Date, required: true },
        resendCount: { type: Number, required: true, default: 0 },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'mfa_challenges' },
    );
    return conn.model('MfaChallenge', schema);
  }

  return {
    async createChallenge(hash, data, ttl) {
      await getModel().create({
        token: hash,
        userId: data.userId,
        purpose: data.purpose,
        emailOtpHash: data.emailOtpHash,
        webauthnChallenge: data.webauthnChallenge,
        sessionId: data.sessionId,
        createdAt: new Date(data.createdAt),
        resendCount: data.resendCount,
        expiresAt: new Date(data.createdAt + ttl * 1000),
      });
    },

    async consumeChallenge(hash) {
      const doc = await getModel().findOneAndDelete({
        token: hash,
        expiresAt: { $gt: new Date() },
      });
      if (!doc) return null;
      return {
        userId: doc.userId,
        purpose: doc.purpose as MfaChallengePurpose,
        emailOtpHash: doc.emailOtpHash,
        webauthnChallenge: doc.webauthnChallenge,
        sessionId: doc.sessionId,
        createdAt: doc.createdAt.getTime(),
        resendCount: doc.resendCount,
      };
    },

    async replaceOtp(hash, newOtpHash, ttl, maxResends) {
      const now = new Date();
      const nowMs = now.getTime();
      const doc = await getModel().findOneAndUpdate(
        {
          token: hash,
          expiresAt: { $gt: now },
          resendCount: { $lt: maxResends },
        },
        [
          {
            $set: {
              emailOtpHash: newOtpHash,
              resendCount: { $add: ['$resendCount', 1] },
              expiresAt: {
                $min: [new Date(nowMs + ttl * 1000), { $add: ['$createdAt', ttl * 3 * 1000] }],
              },
            },
          },
        ],
        { new: true, updatePipeline: true },
      );
      if (!doc) return null;
      return { userId: doc.userId, resendCount: doc.resendCount };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed MFA challenge repository.
 *
 * The `auth_mfa_challenges` table is created on first use (lazy `ensureTable`, idempotent).
 * `consumeChallenge` uses a `DELETE ... RETURNING` for atomic read-and-delete. `replaceOtp`
 * uses a two-query approach (read then update) within a single function call — not wrapped
 * in an explicit transaction, so concurrent resend attempts may over-count by at most one,
 * which is acceptable for the OTP resend use case.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `MfaChallengeRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresMfaChallengeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const mfaRepo = createPostgresMfaChallengeRepository(pool);
 */
export function createPostgresMfaChallengeRepository(
  pool: import('pg').Pool,
): MfaChallengeRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
      token              TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      purpose            TEXT NOT NULL DEFAULT 'login',
      email_otp_hash     TEXT,
      webauthn_challenge TEXT,
      session_id         TEXT,
      created_at         BIGINT NOT NULL,
      resend_count       INTEGER NOT NULL DEFAULT 0,
      expires_at         BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_expires_at ON auth_mfa_challenges(expires_at)',
    );
    tableReady = true;
  };

  return {
    async createChallenge(hash, data, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_mfa_challenges
           (token, user_id, purpose, email_otp_hash, webauthn_challenge, session_id, created_at, resend_count, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (token) DO UPDATE SET
           user_id            = EXCLUDED.user_id,
           purpose            = EXCLUDED.purpose,
           email_otp_hash     = EXCLUDED.email_otp_hash,
           webauthn_challenge = EXCLUDED.webauthn_challenge,
           session_id         = EXCLUDED.session_id,
           created_at         = EXCLUDED.created_at,
           resend_count       = EXCLUDED.resend_count,
           expires_at         = EXCLUDED.expires_at`,
        [
          hash,
          data.userId,
          data.purpose,
          data.emailOtpHash ?? null,
          data.webauthnChallenge ?? null,
          data.sessionId ?? null,
          data.createdAt,
          data.resendCount,
          expiresAt,
        ],
      );
    },
    async consumeChallenge(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{
        user_id: string;
        purpose: string;
        email_otp_hash: string | null;
        webauthn_challenge: string | null;
        session_id: string | null;
        created_at: string;
        resend_count: number;
      }>(
        `DELETE FROM auth_mfa_challenges
         WHERE token = $1 AND expires_at > $2
         RETURNING user_id, purpose, email_otp_hash, webauthn_challenge, session_id, created_at, resend_count`,
        [hash, now],
      );
      if (!rows[0]) return null;
      const row = rows[0];
      return {
        userId: row.user_id,
        purpose: row.purpose as MfaChallengePurpose,
        emailOtpHash: row.email_otp_hash ?? undefined,
        webauthnChallenge: row.webauthn_challenge ?? undefined,
        sessionId: row.session_id ?? undefined,
        createdAt: Number(row.created_at),
        resendCount: row.resend_count,
      };
    },
    async replaceOtp(hash, newOtpHash, ttl, maxResends) {
      await ensureTable();
      const now = Date.now();
      const expiresAt = now + ttl * 1000;
      const maxLifetime = ttl * 3 * 1000;
      const { rows: updated } = await pool.query<{ user_id: string; resend_count: number }>(
        `UPDATE auth_mfa_challenges
         SET email_otp_hash = $1,
             resend_count = resend_count + 1,
             expires_at = LEAST($2, created_at + $3)
         WHERE token = $4
           AND expires_at > $5
           AND resend_count < $6
         RETURNING user_id, resend_count`,
        [newOtpHash, expiresAt, maxLifetime, hash, now, maxResends],
      );
      if (!updated[0]) return null;
      return { userId: updated[0].user_id, resendCount: updated[0].resend_count };
    },
  };
}

export const mfaChallengeFactories: RepoFactories<MfaChallengeRepository> = {
  memory: () => createMemoryMfaChallengeRepository(),
  sqlite: infra => createSqliteMfaChallengeRepository(infra.getSqliteDb()),
  redis: infra => createRedisMfaChallengeRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoMfaChallengeRepository(conn, mg);
  },
  postgres: infra => createPostgresMfaChallengeRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createMfaChallenge = async (
  repo: MfaChallengeRepository,
  userId: string,
  options?: MfaChallengeOptions,
  config?: AuthResolvedConfig,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  const ttl = config?.mfa?.challengeTtlSeconds ?? 300;
  const now = Date.now();

  await repo.createChallenge(
    hash,
    {
      userId,
      purpose: 'login',
      emailOtpHash: options?.emailOtpHash,
      webauthnChallenge: options?.webauthnChallenge,
      createdAt: now,
      resendCount: 0,
    },
    ttl,
  );
  return token;
};

export const consumeMfaChallenge = async (
  repo: MfaChallengeRepository,
  token: string,
): Promise<MfaChallengeData | null> => {
  const hash = sha256(token);
  const record = await repo.consumeChallenge(hash);
  if (!record || record.purpose !== 'login') return null;
  return {
    userId: record.userId,
    purpose: record.purpose,
    emailOtpHash: record.emailOtpHash,
    webauthnChallenge: record.webauthnChallenge,
  };
};

export const replaceMfaChallengeOtp = async (
  repo: MfaChallengeRepository,
  token: string,
  newEmailOtpHash: string,
  config?: AuthResolvedConfig,
): Promise<{ userId: string; resendCount: number } | null> => {
  const hash = sha256(token);
  const ttl = config?.mfa?.challengeTtlSeconds ?? 300;
  return repo.replaceOtp(hash, newEmailOtpHash, ttl, MAX_RESENDS);
};

// ---------------------------------------------------------------------------
// WebAuthn registration challenge helpers
// ---------------------------------------------------------------------------

export const createWebAuthnRegistrationChallenge = async (
  repo: MfaChallengeRepository,
  userId: string,
  challenge: string,
  config?: AuthResolvedConfig,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  const ttl = config?.mfa?.challengeTtlSeconds ?? 300;

  await repo.createChallenge(
    hash,
    {
      userId,
      purpose: 'webauthn-registration',
      webauthnChallenge: challenge,
      createdAt: Date.now(),
      resendCount: 0,
    },
    ttl,
  );
  return token;
};

export const consumeWebAuthnRegistrationChallenge = async (
  repo: MfaChallengeRepository,
  token: string,
): Promise<{ userId: string; challenge: string } | null> => {
  const hash = sha256(token);
  const record = await repo.consumeChallenge(hash);
  if (!record || record.purpose !== 'webauthn-registration' || !record.webauthnChallenge)
    return null;
  return { userId: record.userId, challenge: record.webauthnChallenge };
};

// ---------------------------------------------------------------------------
// Passkey login challenge helpers
// ---------------------------------------------------------------------------

const PASSKEY_LOGIN_CHALLENGE_TTL = 120;

export const createPasskeyLoginChallenge = async (
  repo: MfaChallengeRepository,
  challenge: string,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);

  await repo.createChallenge(
    hash,
    {
      userId: '',
      purpose: 'passkey-login',
      webauthnChallenge: challenge,
      createdAt: Date.now(),
      resendCount: 0,
    },
    PASSKEY_LOGIN_CHALLENGE_TTL,
  );
  return token;
};

export const consumePasskeyLoginChallenge = async (
  repo: MfaChallengeRepository,
  token: string,
): Promise<{ webauthnChallenge: string } | null> => {
  const hash = sha256(token);
  const record = await repo.consumeChallenge(hash);
  if (!record || record.purpose !== 'passkey-login' || !record.webauthnChallenge) return null;
  return { webauthnChallenge: record.webauthnChallenge };
};

// ---------------------------------------------------------------------------
// Reauth challenge helpers
// ---------------------------------------------------------------------------

export const createReauthChallenge = async (
  repo: MfaChallengeRepository,
  userId: string,
  sessionId: string,
  options?: ReauthChallengeOptions,
  config?: AuthResolvedConfig,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  const ttl = options?.ttlSeconds ?? config?.mfa?.challengeTtlSeconds ?? 300;

  await repo.createChallenge(
    hash,
    {
      userId,
      purpose: 'reauth',
      emailOtpHash: options?.emailOtpHash,
      webauthnChallenge: options?.webauthnChallenge,
      sessionId,
      createdAt: Date.now(),
      resendCount: 0,
    },
    ttl,
  );
  return token;
};

export const consumeReauthChallenge = async (
  repo: MfaChallengeRepository,
  token: string,
  sessionId: string,
): Promise<MfaChallengeData | null> => {
  const hash = sha256(token);
  const record = await repo.consumeChallenge(hash);
  if (!record || record.purpose !== 'reauth') return null;
  if (!record.sessionId || !timingSafeEqual(record.sessionId, sessionId)) return null;
  return {
    userId: record.userId,
    purpose: record.purpose,
    emailOtpHash: record.emailOtpHash,
    webauthnChallenge: record.webauthnChallenge,
    sessionId: record.sessionId,
  };
};

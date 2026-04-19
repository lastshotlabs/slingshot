import { createHash } from 'node:crypto';
import { hashToken } from '@lastshotlabs/slingshot-core';
import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import { createPostgresInitializer } from '../postgresInit';
import { getSessionTtlMs, isIdleExpired, shouldPersistSessionMetadata } from './policy';
import type { SessionRepository } from './repository';
import type { SessionInfo } from './types';

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

const SESSION_CREATE_LOCK_NAMESPACE = 'slingshot-auth:session:max-sessions:v1';

function sessionCreateLockId(userId: string): string {
  const digest = createHash('sha256')
    .update(SESSION_CREATE_LOCK_NAMESPACE)
    .update('\0')
    .update(userId)
    .digest();
  return digest.readBigInt64BE(0).toString();
}

export function createPostgresSessionRepository(pool: import('pg').Pool): SessionRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id             TEXT PRIMARY KEY,
      user_id                TEXT NOT NULL,
      token                  TEXT,
      created_at             BIGINT NOT NULL,
      last_active_at         BIGINT NOT NULL,
      expires_at             BIGINT NOT NULL,
      ip_address             TEXT,
      user_agent             TEXT,
      refresh_token          TEXT,
      prev_refresh_token     TEXT,
      prev_token_expires_at  BIGINT,
      fingerprint            TEXT,
      mfa_verified_at        BIGINT
    )`);
    await client.query('ALTER TABLE auth_sessions DROP COLUMN IF EXISTS refresh_token_plain');
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)',
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_refresh_token
       ON auth_sessions(refresh_token) WHERE refresh_token IS NOT NULL`,
    );
  });

  async function deleteSessionImpl(sessionId: string, cfg?: AuthResolvedConfig): Promise<void> {
    if (shouldPersistSessionMetadata(cfg)) {
      await pool.query(
        `UPDATE auth_sessions
         SET token = NULL, refresh_token = NULL, prev_refresh_token = NULL,
             prev_token_expires_at = NULL
         WHERE session_id = $1`,
        [sessionId],
      );
    } else {
      await pool.query('DELETE FROM auth_sessions WHERE session_id = $1', [sessionId]);
    }
  }

  return {
    async createSession(userId, token, sessionId, metadata?, cfg?) {
      await ensureTable();
      const now = Date.now();
      const expiresAt = now + getSessionTtlMs(cfg);
      await pool.query(
        `INSERT INTO auth_sessions
           (session_id, user_id, token, created_at, last_active_at, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id) DO NOTHING`,
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

    async atomicCreateSession(userId, token, sessionId, maxSessions, metadata?, cfg?) {
      await ensureTable();
      const now = Date.now();
      const expiresAt = now + getSessionTtlMs(cfg);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize max-session enforcement per user so concurrent logins
        // cannot both see the same active count and overrun the cap.
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          sessionCreateLockId(userId),
        ]);
        // Count active sessions
        const { rows: countRows } = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM auth_sessions
           WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2`,
          [userId, now],
        );
        let activeCount = Number(countRows[0]?.count ?? 0);

        // Evict oldest sessions until we're under the limit
        while (activeCount >= maxSessions) {
          const { rows: oldest } = await client.query<{ session_id: string }>(
            `SELECT session_id FROM auth_sessions
             WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2
             ORDER BY created_at ASC LIMIT 1`,
            [userId, now],
          );
          if (!oldest[0]) break;
          const shouldPersist = shouldPersistSessionMetadata(cfg);
          if (shouldPersist) {
            await client.query(
              `UPDATE auth_sessions
               SET token = NULL, refresh_token = NULL, prev_refresh_token = NULL,
                   prev_token_expires_at = NULL
               WHERE session_id = $1`,
              [oldest[0].session_id],
            );
          } else {
            await client.query('DELETE FROM auth_sessions WHERE session_id = $1', [
              oldest[0].session_id,
            ]);
          }
          activeCount--;
        }

        await client.query(
          `INSERT INTO auth_sessions
             (session_id, user_id, token, created_at, last_active_at, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (session_id) DO NOTHING`,
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
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getSession(sessionId, cfg?) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ token: string | null; last_active_at: string }>(
        'SELECT token, last_active_at FROM auth_sessions WHERE session_id = $1 AND expires_at > $2',
        [sessionId, now],
      );
      if (!rows[0] || !rows[0].token) return null;
      if (isIdleExpired(Number(rows[0].last_active_at), cfg)) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }
      return rows[0].token;
    },

    async deleteSession(sessionId, cfg?) {
      await ensureTable();
      await deleteSessionImpl(sessionId, cfg);
    },

    async getUserSessions(userId, cfg?) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{
        session_id: string;
        token: string | null;
        created_at: string;
        last_active_at: string;
        expires_at: string;
        ip_address: string | null;
        user_agent: string | null;
      }>(
        `SELECT session_id, token, created_at, last_active_at, expires_at, ip_address, user_agent
         FROM auth_sessions WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      );
      const config = cfg ?? DEFAULT_AUTH_CONFIG;
      const includeInactive = config.includeInactiveSessions;
      const persist = config.persistSessionMetadata;
      const results: SessionInfo[] = [];
      for (const row of rows) {
        const isActive = !!row.token && Number(row.expires_at) > now;
        if (!isActive && !persist) continue;
        if (!isActive && !includeInactive) continue;
        results.push({
          sessionId: row.session_id,
          createdAt: Number(row.created_at),
          lastActiveAt: Number(row.last_active_at),
          expiresAt: Number(row.expires_at),
          ipAddress: row.ip_address ?? undefined,
          userAgent: row.user_agent ?? undefined,
          isActive,
        });
      }
      return results;
    },

    async getActiveSessionCount(userId) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM auth_sessions
         WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2`,
        [userId, now],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async evictOldestSession(userId, cfg?) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ session_id: string }>(
        `SELECT session_id FROM auth_sessions
         WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2
         ORDER BY created_at ASC LIMIT 1`,
        [userId, now],
      );
      if (rows[0]) await deleteSessionImpl(rows[0].session_id, cfg);
    },

    async updateSessionLastActive(sessionId) {
      await ensureTable();
      await pool.query('UPDATE auth_sessions SET last_active_at = $1 WHERE session_id = $2', [
        Date.now(),
        sessionId,
      ]);
    },

    async setRefreshToken(sessionId, refreshToken) {
      await ensureTable();
      const tokenHash = hashToken(refreshToken);
      await pool.query('UPDATE auth_sessions SET refresh_token = $1 WHERE session_id = $2', [
        tokenHash,
        sessionId,
      ]);
    },

    async getSessionByRefreshToken(refreshToken, cfg?) {
      await ensureTable();
      const tokenHash = hashToken(refreshToken);

      // Try current refresh token
      const { rows } = await pool.query<{
        session_id: string;
        user_id: string;
        last_active_at: string;
      }>(
        `SELECT session_id, user_id, last_active_at
         FROM auth_sessions WHERE refresh_token = $1`,
        [tokenHash],
      );
      if (rows[0]) {
        if (isIdleExpired(Number(rows[0].last_active_at), cfg)) {
          await deleteSessionImpl(rows[0].session_id, cfg);
          return null;
        }
        return {
          sessionId: rows[0].session_id,
          userId: rows[0].user_id,
          fromGrace: false,
        };
      }

      // Try previous refresh token (grace window)
      const { rows: graceRows } = await pool.query<{
        session_id: string;
        user_id: string;
        prev_token_expires_at: string | null;
        last_active_at: string;
      }>(
        `SELECT session_id, user_id, prev_token_expires_at, last_active_at
         FROM auth_sessions WHERE prev_refresh_token = $1`,
        [tokenHash],
      );
      if (!graceRows[0]) return null;
      const graceRow = graceRows[0];
      if (isIdleExpired(Number(graceRow.last_active_at), cfg)) {
        await deleteSessionImpl(graceRow.session_id, cfg);
        return null;
      }
      if (graceRow.prev_token_expires_at && Number(graceRow.prev_token_expires_at) > Date.now()) {
        return {
          sessionId: graceRow.session_id,
          userId: graceRow.user_id,
          fromGrace: true,
        };
      }
      await deleteSessionImpl(graceRow.session_id, cfg);
      return null;
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, newAccessToken, cfg?) {
      await ensureTable();
      const graceSeconds = (cfg ?? DEFAULT_AUTH_CONFIG).refreshToken?.rotationGraceSeconds ?? 10;
      const prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      const newHash = hashToken(newRefreshToken);

      if (oldRefreshToken !== undefined) {
        const oldHash = hashToken(oldRefreshToken);
        const { rowCount } = await pool.query(
          `UPDATE auth_sessions
           SET prev_refresh_token = refresh_token,
               prev_token_expires_at = $1,
               refresh_token = $2,
               token = $3
           WHERE session_id = $4 AND refresh_token = $5`,
          [prevTokenExpiresAt, newHash, newAccessToken, sessionId, oldHash],
        );
        return (rowCount ?? 0) > 0;
      }
      await pool.query(
        `UPDATE auth_sessions
         SET prev_refresh_token = refresh_token,
             prev_token_expires_at = $1,
             refresh_token = $2,
             token = $3
         WHERE session_id = $4`,
        [prevTokenExpiresAt, newHash, newAccessToken, sessionId],
      );
      return true;
    },

    async getSessionFingerprint(sessionId) {
      await ensureTable();
      const { rows } = await pool.query<{ fingerprint: string | null }>(
        'SELECT fingerprint FROM auth_sessions WHERE session_id = $1',
        [sessionId],
      );
      return rows[0]?.fingerprint ?? null;
    },

    async setSessionFingerprint(sessionId, fingerprint) {
      await ensureTable();
      await pool.query('UPDATE auth_sessions SET fingerprint = $1 WHERE session_id = $2', [
        fingerprint,
        sessionId,
      ]);
    },

    async setMfaVerifiedAt(sessionId) {
      await ensureTable();
      const now = Math.floor(Date.now() / 1000);
      await pool.query('UPDATE auth_sessions SET mfa_verified_at = $1 WHERE session_id = $2', [
        now,
        sessionId,
      ]);
    },

    async getMfaVerifiedAt(sessionId) {
      await ensureTable();
      const { rows } = await pool.query<{ mfa_verified_at: string | null }>(
        'SELECT mfa_verified_at FROM auth_sessions WHERE session_id = $1',
        [sessionId],
      );
      const val = rows[0]?.mfa_verified_at;
      return val != null ? Number(val) : null;
    },
  };
}

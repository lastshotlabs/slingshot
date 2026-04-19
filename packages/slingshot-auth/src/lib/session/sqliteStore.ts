 
import { hashToken } from '@lastshotlabs/slingshot-core';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import {
  isSqliteMissingColumnError,
  isSqliteUnsupportedDropColumnError,
} from '../sqliteSchemaErrors';
import { getSessionTtlMs, isIdleExpired } from './policy';
import type { SessionRepository } from './repository';
import type { SessionInfo } from './types';

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed session repository.
 *
 * Creates the `sessions` table (and supporting indexes) if they do not already exist.
 * Uses a WAL-compatible schema shared with `createSqliteAuthAdapter` — the table is
 * safe to have created by either party.
 *
 * @param db - An open `RuntimeSqliteDatabase` handle (e.g. from `slingshot-core`'s SQLite runtime).
 * @returns A `SessionRepository` backed by SQLite.
 *
 * @example
 * import { createSqliteSessionRepository } from '@lastshotlabs/slingshot-auth';
 *
 * const db = sqlite.open('/data/auth.db');
 * const sessionRepo = createSqliteSessionRepository(db);
 * await sessionRepo.createSession('user-1', 'jwt-token', 'session-uuid');
 *
 * @remarks
 * Initialization is lazy — the table is created on the first operation, not at
 * construction time. This avoids issues when the database file is opened before
 * migrations have run.
 */
export function createSqliteSessionRepository(db: RuntimeSqliteDatabase): SessionRepository {
  let initialized = false;

  interface CountRow {
    count: number;
  }

  interface SessionIdRow {
    sessionId: string;
  }

  interface UserSessionRow {
    sessionId: string;
    token: string | null;
    createdAt: number;
    lastActiveAt: number;
    expiresAt: number;
    ipAddress: string | null;
    userAgent: string | null;
  }

  interface FingerprintRow {
    fingerprint: string | null;
  }

  interface MfaVerifiedAtRow {
    mfaVerifiedAt: number | null;
  }

  function init(): void {
    if (initialized) return;
    // Sessions table is created by sqliteAuth adapter's initSchema.
    // Only create if it doesn't exist (standalone usage).
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
      mfaVerifiedAt     INTEGER
    )`);
    try {
      db.run('UPDATE sessions SET refreshTokenPlain = NULL WHERE refreshTokenPlain IS NOT NULL');
    } catch (err) {
      if (!isSqliteMissingColumnError(err, 'refreshTokenPlain')) throw err;
      // Older/newer schemas may omit the legacy plaintext column.
    }
    try {
      db.run('ALTER TABLE sessions DROP COLUMN refreshTokenPlain');
    } catch (err) {
      if (
        !isSqliteMissingColumnError(err, 'refreshTokenPlain') &&
        !isSqliteUnsupportedDropColumnError(err)
      ) {
        throw err;
      }
      // Older SQLite engines may not support DROP COLUMN. The legacy values were scrubbed above.
    }
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId)');
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refreshToken ON sessions(refreshToken) WHERE refreshToken IS NOT NULL',
    );
    initialized = true;
  }

  function deleteSessionImpl(sessionId: string, cfg?: AuthResolvedConfig): void {
    init();
    if ((cfg ?? DEFAULT_AUTH_CONFIG).persistSessionMetadata) {
      db.run(
        'UPDATE sessions SET token = NULL, refreshToken = NULL, prevRefreshToken = NULL, prevTokenExpiresAt = NULL WHERE sessionId = ?',
        sessionId,
      );
    } else {
      db.run('DELETE FROM sessions WHERE sessionId = ?', sessionId);
    }
  }

  return {
    async createSession(userId, token, sessionId, metadata?, cfg?) {
      init();
      const now = Date.now();
      const expiresAt = now + getSessionTtlMs(cfg);
      db.run(
        'INSERT INTO sessions (sessionId, userId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId,
        userId,
        token,
        now,
        now,
        expiresAt,
        metadata?.ipAddress ?? null,
        metadata?.userAgent ?? null,
      );
    },

    async atomicCreateSession(userId, token, sessionId, maxSessions, metadata?, cfg?) {
      init();
      const now = Date.now();
      const ttlMs = getSessionTtlMs(cfg);
      const expiresAt = now + ttlMs;

      db.transaction(() => {
        const countRow = db
          .query(
            'SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ?',
          )
          .get(userId, now) as CountRow | null;
        let activeCount = countRow?.count ?? 0;

        while (activeCount >= maxSessions) {
          const oldest = db
            .query(
              'SELECT sessionId FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ? ORDER BY createdAt ASC LIMIT 1',
            )
            .get(userId, now) as SessionIdRow | null;
          if (!oldest) break;
          deleteSessionImpl(oldest.sessionId, cfg);
          activeCount--;
        }

        db.run(
          'INSERT INTO sessions (sessionId, userId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          sessionId,
          userId,
          token,
          now,
          now,
          expiresAt,
          metadata?.ipAddress ?? null,
          metadata?.userAgent ?? null,
        );
      })();
    },

    async getSession(sessionId, cfg?) {
      init();
      const row = db
        .query('SELECT token, lastActiveAt FROM sessions WHERE sessionId = ? AND expiresAt > ?')
        .get(sessionId, Date.now()) as { token: string | null; lastActiveAt: number } | null;
      if (!row || !row.token) return null;
      if (isIdleExpired(row.lastActiveAt, cfg)) {
        deleteSessionImpl(sessionId, cfg);
        return null;
      }
      return row.token;
    },

    async deleteSession(sessionId, cfg?) {
      deleteSessionImpl(sessionId, cfg);
    },

    async getUserSessions(userId, cfg?) {
      init();
      const now = Date.now();
      const rows = db
        .query(
          'SELECT sessionId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent FROM sessions WHERE userId = ? ORDER BY createdAt ASC',
        )
        .all(userId) as UserSessionRow[];

      const config = cfg ?? DEFAULT_AUTH_CONFIG;
      const includeInactive = config.includeInactiveSessions;
      const persist = config.persistSessionMetadata;
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

    async getActiveSessionCount(userId) {
      init();
      const row = db
        .query(
          'SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ?',
        )
        .get(userId, Date.now()) as CountRow | null;
      return row?.count ?? 0;
    },

    async evictOldestSession(userId, cfg?) {
      init();
      const now = Date.now();
      const oldest = db
        .query(
          'SELECT sessionId FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ? ORDER BY createdAt ASC LIMIT 1',
        )
        .get(userId, now) as SessionIdRow | null;
      if (oldest) deleteSessionImpl(oldest.sessionId, cfg);
    },

    async updateSessionLastActive(sessionId) {
      init();
      db.run('UPDATE sessions SET lastActiveAt = ? WHERE sessionId = ?', Date.now(), sessionId);
    },

    async setRefreshToken(sessionId, refreshToken) {
      init();
      const tokenHash = hashToken(refreshToken);
      db.run('UPDATE sessions SET refreshToken = ? WHERE sessionId = ?', tokenHash, sessionId);
    },

    async getSessionByRefreshToken(refreshToken, cfg?) {
      init();
      const tokenHash = hashToken(refreshToken);

      const row = db
        .query(
          'SELECT sessionId, userId, refreshToken, lastActiveAt FROM sessions WHERE refreshToken = ?',
        )
        .get(tokenHash) as {
        sessionId: string;
        userId: string;
        refreshToken: string | null;
        lastActiveAt: number;
      } | null;
      if (row) {
        if (isIdleExpired(row.lastActiveAt, cfg)) {
          deleteSessionImpl(row.sessionId, cfg);
          return null;
        }
        return {
          sessionId: row.sessionId,
          userId: row.userId,
          fromGrace: false,
        };
      }

      interface GraceWindowRow {
        sessionId: string;
        userId: string;
        prevTokenExpiresAt: number | null;
        lastActiveAt: number;
      }
      const graceRow = db
        .query(
          'SELECT sessionId, userId, prevTokenExpiresAt, lastActiveAt FROM sessions WHERE prevRefreshToken = ?',
        )
        .get(tokenHash) as GraceWindowRow | null;
      if (!graceRow) return null;
      if (isIdleExpired(graceRow.lastActiveAt, cfg)) {
        deleteSessionImpl(graceRow.sessionId, cfg);
        return null;
      }

      if (graceRow.prevTokenExpiresAt && graceRow.prevTokenExpiresAt > Date.now()) {
        return {
          sessionId: graceRow.sessionId,
          userId: graceRow.userId,
          fromGrace: true,
        };
      }

      deleteSessionImpl(graceRow.sessionId, cfg);
      return null;
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, newAccessToken, cfg?) {
      init();
      const graceSeconds = (cfg ?? DEFAULT_AUTH_CONFIG).refreshToken?.rotationGraceSeconds ?? 10;
      const prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      const newHash = hashToken(newRefreshToken);
      if (oldRefreshToken !== undefined) {
        // Atomic guard: only rotate if the current token still matches the one we read.
        // If another concurrent request already rotated it, changes will be 0 → return false.
        const oldHash = hashToken(oldRefreshToken);
        const stmt = db.prepare(
          'UPDATE sessions SET prevRefreshToken = refreshToken, prevTokenExpiresAt = ?, refreshToken = ?, token = ? WHERE sessionId = ? AND refreshToken = ?',
        );
        const { changes } = stmt.run(
          prevTokenExpiresAt,
          newHash,
          newAccessToken,
          sessionId,
          oldHash,
        );
        return changes > 0;
      }
      db.run(
        'UPDATE sessions SET prevRefreshToken = refreshToken, prevTokenExpiresAt = ?, refreshToken = ?, token = ? WHERE sessionId = ?',
        prevTokenExpiresAt,
        newHash,
        newAccessToken,
        sessionId,
      );
      return true;
    },

    async getSessionFingerprint(sessionId) {
      init();
      const row = db
        .query('SELECT fingerprint FROM sessions WHERE sessionId = ?')
        .get(sessionId) as FingerprintRow | null;
      return row?.fingerprint ?? null;
    },

    async setSessionFingerprint(sessionId, fingerprint) {
      init();
      db.run('UPDATE sessions SET fingerprint = ? WHERE sessionId = ?', fingerprint, sessionId);
    },

    async setMfaVerifiedAt(sessionId) {
      init();
      const now = Math.floor(Date.now() / 1000);
      db.run('UPDATE sessions SET mfaVerifiedAt = ? WHERE sessionId = ?', now, sessionId);
    },

    async getMfaVerifiedAt(sessionId) {
      init();
      const row = db
        .query('SELECT mfaVerifiedAt FROM sessions WHERE sessionId = ?')
        .get(sessionId) as MfaVerifiedAtRow | null;
      return row?.mfaVerifiedAt ?? null;
    },
  };
}

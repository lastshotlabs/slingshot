/* eslint-disable @typescript-eslint/require-await */
import { DEFAULT_MAX_ENTRIES, hashToken, timingSafeEqual } from '@lastshotlabs/slingshot-core';
import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import { getSessionTtlMs, isIdleExpired, shouldPersistSessionMetadata } from './policy';
import type { SessionRepository } from './repository';
import type { SessionInfo, SessionMetadata } from './types';

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemorySession {
  sessionId: string;
  userId: string;
  token: string | null;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
  refreshToken?: string | null;
  prevRefreshToken?: string | null;
  prevTokenExpiresAt?: number | null;
  fingerprint?: string | null;
  mfaVerifiedAt?: number | null;
}

/**
 * Creates an in-memory session repository.
 *
 * Stores all session state in process memory using `Map`s. Suitable for development,
 * testing, and single-server deployments where session durability across restarts is
 * not required.
 *
 * Each call returns a completely independent instance with its own closure-owned Maps —
 * no shared module-level state (factory pattern, Rule 3).
 *
 * @returns A `SessionRepository` backed by in-memory Maps.
 *
 * @example
 * // In tests — create a fresh instance per test suite
 * const sessionRepo = createMemorySessionRepository();
 * await sessionRepo.createSession('user-1', 'jwt-token', 'session-uuid');
 *
 * @remarks
 * Session entries are automatically evicted when the `DEFAULT_MAX_ENTRIES` cap is
 * reached (oldest evicted first). Expired tombstones (when `persistSessionMetadata`
 * is true) are swept opportunistically on delete and create operations.
 */
export function createMemorySessionRepository(): SessionRepository {
  const sessions = new Map<string, MemorySession>();
  const userSessionIds = new Map<string, Set<string>>();
  const refreshTokenIndex = new Map<string, string>();

  function removeUserSessionId(userId: string, sessionId: string): void {
    const ids = userSessionIds.get(userId);
    if (!ids) return;
    ids.delete(sessionId);
    if (ids.size === 0) {
      userSessionIds.delete(userId);
    }
  }

  function purgeSessionImpl(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.refreshToken) refreshTokenIndex.delete(entry.refreshToken);
    if (entry.prevRefreshToken) refreshTokenIndex.delete(entry.prevRefreshToken);
    sessions.delete(sessionId);
    removeUserSessionId(entry.userId, sessionId);
  }

  // Purge tombstoned sessions (token === null) whose natural TTL has passed.
  // Called opportunistically on delete and on new-session creation so expired
  // tombstones do not accumulate indefinitely in the in-memory dev store.
  function sweepExpiredTombstones(): void {
    const now = Date.now();
    for (const [sessionId, s] of sessions) {
      if (!s.token && s.expiresAt <= now) {
        purgeSessionImpl(sessionId);
      }
    }
  }

  function deleteSessionImpl(sessionId: string, cfg?: AuthResolvedConfig): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (shouldPersistSessionMetadata(cfg)) {
      if (entry.refreshToken) refreshTokenIndex.delete(entry.refreshToken);
      if (entry.prevRefreshToken) refreshTokenIndex.delete(entry.prevRefreshToken);
      entry.token = null;
      entry.refreshToken = null;
      entry.prevRefreshToken = null;
      entry.prevTokenExpiresAt = null;
      sweepExpiredTombstones();
    } else {
      purgeSessionImpl(sessionId);
    }
  }

  function trimSessionsToCapacity(): void {
    sweepExpiredTombstones();
    while (sessions.size >= DEFAULT_MAX_ENTRIES) {
      const oldestSessionId = sessions.keys().next().value;
      if (oldestSessionId === undefined) break;
      purgeSessionImpl(oldestSessionId);
    }
  }

  function createSessionImpl(
    userId: string,
    token: string,
    sessionId: string,
    metadata?: SessionMetadata,
    cfg?: AuthResolvedConfig,
  ): void {
    const now = Date.now();
    const session: MemorySession = {
      sessionId,
      userId,
      token,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + getSessionTtlMs(cfg),
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    };
    trimSessionsToCapacity();
    sessions.set(sessionId, session);
    if (!userSessionIds.has(userId)) userSessionIds.set(userId, new Set());
    const ids = userSessionIds.get(userId);
    if (ids) ids.add(sessionId);
  }

  return {
    async createSession(userId, token, sessionId, metadata?, cfg?) {
      createSessionImpl(userId, token, sessionId, metadata, cfg);
    },

    async atomicCreateSession(userId, token, sessionId, maxSessions, metadata?, cfg?) {
      const now = Date.now();
      const ids = userSessionIds.get(userId);
      if (ids) {
        let activeCount = 0;
        let oldest: MemorySession | null = null;
        for (const sid of ids) {
          const s = sessions.get(sid);
          if (s && s.token && s.expiresAt > now) {
            activeCount++;
            if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
          }
        }
        while (activeCount >= maxSessions && oldest) {
          deleteSessionImpl(oldest.sessionId, cfg);
          activeCount--;
          oldest = null;
          for (const sid of ids) {
            const s = sessions.get(sid);
            if (s && s.token && s.expiresAt > now) {
              if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
            }
          }
        }
      }
      createSessionImpl(userId, token, sessionId, metadata, cfg);
    },

    async getSession(sessionId, cfg?) {
      const entry = sessions.get(sessionId);
      if (!entry || !entry.token || entry.expiresAt <= Date.now()) return null;
      if (isIdleExpired(entry.lastActiveAt, cfg)) {
        deleteSessionImpl(sessionId, cfg);
        return null;
      }
      return entry.token;
    },

    async deleteSession(sessionId, cfg?) {
      deleteSessionImpl(sessionId, cfg);
    },

    async getUserSessions(userId, cfg?) {
      const ids = userSessionIds.get(userId);
      if (!ids) return [];
      const now = Date.now();
      const config = cfg ?? DEFAULT_AUTH_CONFIG;
      const includeInactive = config.includeInactiveSessions;
      const persist = config.persistSessionMetadata;
      const results: SessionInfo[] = [];
      for (const sessionId of ids) {
        const s = sessions.get(sessionId);
        if (!s) continue;
        const isActive = !!s.token && s.expiresAt > now;
        if (!isActive && !persist) continue;
        if (!isActive && !includeInactive) continue;
        results.push({
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expiresAt: s.expiresAt,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          isActive,
        });
      }
      return results;
    },

    async getActiveSessionCount(userId) {
      const ids = userSessionIds.get(userId);
      if (!ids) return 0;
      const now = Date.now();
      let count = 0;
      for (const sessionId of ids) {
        const s = sessions.get(sessionId);
        if (s && s.token && s.expiresAt > now) count++;
      }
      return count;
    },

    async evictOldestSession(userId, cfg?) {
      const ids = userSessionIds.get(userId);
      if (!ids) return;
      const now = Date.now();
      let oldest: MemorySession | null = null;
      for (const sessionId of ids) {
        const s = sessions.get(sessionId);
        if (!s || !s.token || s.expiresAt <= now) continue;
        if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
      }
      if (oldest) deleteSessionImpl(oldest.sessionId, cfg);
    },

    async updateSessionLastActive(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.lastActiveAt = Date.now();
    },

    async setRefreshToken(sessionId, refreshToken) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      const tokenHash = hashToken(refreshToken);
      if (entry.refreshToken && entry.refreshToken !== tokenHash) {
        refreshTokenIndex.delete(entry.refreshToken);
      }
      entry.refreshToken = tokenHash;
      refreshTokenIndex.set(tokenHash, sessionId);
    },

    async getSessionByRefreshToken(refreshToken, cfg?) {
      const tokenHash = hashToken(refreshToken);
      const sessionId = refreshTokenIndex.get(tokenHash);
      if (!sessionId) return null;
      const entry = sessions.get(sessionId);
      if (!entry) return null;

      if (isIdleExpired(entry.lastActiveAt, cfg)) {
        deleteSessionImpl(sessionId, cfg);
        return null;
      }

      if (entry.refreshToken && timingSafeEqual(entry.refreshToken, tokenHash)) {
        return {
          sessionId: entry.sessionId,
          userId: entry.userId,
          fromGrace: false,
        };
      }

      if (
        entry.prevRefreshToken &&
        timingSafeEqual(entry.prevRefreshToken, tokenHash) &&
        entry.prevTokenExpiresAt &&
        entry.prevTokenExpiresAt > Date.now()
      ) {
        return {
          sessionId: entry.sessionId,
          userId: entry.userId,
          fromGrace: true,
        };
      }

      if (entry.prevRefreshToken && timingSafeEqual(entry.prevRefreshToken, tokenHash)) {
        deleteSessionImpl(sessionId, cfg);
        return null;
      }

      return null;
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, newAccessToken, cfg?) {
      const entry = sessions.get(sessionId);
      if (!entry) return false;
      // Guard: reject if the current token no longer matches — another concurrent request
      // already rotated it. Skip the guard for grace-window re-rotations (oldRefreshToken=undefined).
      if (oldRefreshToken !== undefined && entry.refreshToken !== hashToken(oldRefreshToken))
        return false;
      const graceSeconds = (cfg ?? DEFAULT_AUTH_CONFIG).refreshToken?.rotationGraceSeconds ?? 10;
      const newHash = hashToken(newRefreshToken);

      const oldHash = entry.refreshToken;
      if (entry.prevRefreshToken && entry.prevRefreshToken !== oldHash) {
        refreshTokenIndex.delete(entry.prevRefreshToken);
      }
      entry.prevRefreshToken = oldHash;
      entry.prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      entry.refreshToken = newHash;
      entry.token = newAccessToken;

      refreshTokenIndex.set(newHash, sessionId);
      return true;
    },

    async getSessionFingerprint(sessionId) {
      return sessions.get(sessionId)?.fingerprint ?? null;
    },

    async setSessionFingerprint(sessionId, fingerprint) {
      const entry = sessions.get(sessionId);
      if (entry) entry.fingerprint = fingerprint;
    },

    async setMfaVerifiedAt(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.mfaVerifiedAt = Math.floor(Date.now() / 1000);
    },

    async getMfaVerifiedAt(sessionId) {
      return sessions.get(sessionId)?.mfaVerifiedAt ?? null;
    },
  };
}

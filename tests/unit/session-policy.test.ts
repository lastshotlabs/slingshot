import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import {
  type AuthResolvedConfig,
  DEFAULT_AUTH_CONFIG,
  createAuthResolvedConfig,
} from '@auth/config/authConfig';
import {
  type SessionRepository,
  getSession,
  getSessionByRefreshToken,
  rotateRefreshToken,
} from '@auth/lib/session';
import { beforeEach, describe, expect, test } from 'bun:test';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let currentConfig: AuthResolvedConfig = DEFAULT_AUTH_CONFIG;
let stores: ReturnType<typeof createMemoryAuthAdapter>;
let repo: SessionRepository;

/**
 * Wraps the memory adapter instance as an SessionRepository so the session lib
 * wrapper functions (getSession, getSessionByRefreshToken, rotateRefreshToken)
 * operate on the same underlying state as the direct adapter methods.
 */
function adapterAsRepo(adapter: ReturnType<typeof createMemoryAuthAdapter>): SessionRepository {
  return {
    createSession: async (userId, token, sessionId, metadata?, cfg?) => {
      adapter.memoryCreateSession(userId, token, sessionId, metadata);
    },
    atomicCreateSession: async (userId, token, sessionId, maxSessions, metadata?, cfg?) => {
      adapter.memoryAtomicCreateSession(userId, token, sessionId, maxSessions, metadata);
    },
    getSession: async (sessionId, cfg?) => {
      const record = adapter.memoryGetSessionRecord(sessionId);
      if (!record) return null;
      const idleTimeout = (cfg ?? DEFAULT_AUTH_CONFIG).sessionPolicy.idleTimeout;
      if (idleTimeout && (Date.now() - record.lastActiveAt) / 1000 > idleTimeout) {
        adapter.memoryDeleteSession(sessionId);
        return null;
      }
      return record.token;
    },
    deleteSession: async sessionId => adapter.memoryDeleteSession(sessionId),
    getUserSessions: async userId => adapter.memoryGetUserSessions(userId),
    getActiveSessionCount: async userId => adapter.memoryGetActiveSessionCount(userId),
    evictOldestSession: async userId => adapter.memoryEvictOldestSession(userId),
    updateSessionLastActive: async sessionId => adapter.memoryUpdateSessionLastActive(sessionId),
    setRefreshToken: async (sessionId, refreshToken) =>
      adapter.memorySetRefreshToken(sessionId, refreshToken),
    getSessionByRefreshToken: async (refreshToken, cfg?) => {
      const result = adapter.memoryGetSessionByRefreshToken(refreshToken);
      if (!result) return null;
      const record = adapter.memoryGetSessionRecord(result.sessionId);
      if (!record) return null;
      const idleTimeout = (cfg ?? DEFAULT_AUTH_CONFIG).sessionPolicy.idleTimeout;
      if (idleTimeout && (Date.now() - record.lastActiveAt) / 1000 > idleTimeout) {
        adapter.memoryDeleteSession(result.sessionId);
        return null;
      }
      return result;
    },
    rotateRefreshToken: async (sessionId, _oldRefreshToken, newRefreshToken, newAccessToken) => {
      adapter.memoryRotateRefreshToken(sessionId, newRefreshToken, newAccessToken);
      return true;
    },
    getSessionFingerprint: async sessionId => adapter.memoryGetSessionFingerprint(sessionId),
    setSessionFingerprint: async (sessionId, fingerprint) =>
      adapter.memorySetSessionFingerprint(sessionId, fingerprint),
    setMfaVerifiedAt: async sessionId =>
      adapter.memorySetMfaVerifiedAt(sessionId, Math.floor(Date.now() / 1000)),
    getMfaVerifiedAt: async sessionId => adapter.memoryGetMfaVerifiedAt(sessionId),
  };
}

beforeEach(() => {
  currentConfig = DEFAULT_AUTH_CONFIG;
  stores = createMemoryAuthAdapter(() => currentConfig);
  repo = adapterAsRepo(stores);
});

// Helpers
function makeSession(userId = 'user1', token = 'tok1') {
  const sessionId = crypto.randomUUID();
  stores.memoryCreateSession(userId, token, sessionId);
  return sessionId;
}

function backdateLastActive(sessionId: string, msAgo: number) {
  stores.memorySetSessionLastActive(sessionId, Date.now() - msAgo);
}

describe('getSession — idle timeout', () => {
  test('returns token when no idle timeout is configured', async () => {
    const sid = makeSession('user1', 'tok1');
    expect(await getSession(repo, sid, DEFAULT_AUTH_CONFIG)).toBe('tok1');
  });

  test('returns null for session that exceeded idle timeout', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } }); // 1 hour
    const sid = makeSession('user1', 'tok-idle');
    // Backdate lastActiveAt to 2 hours ago
    backdateLastActive(sid, 2 * ONE_HOUR_MS);
    expect(await getSession(repo, sid, currentConfig)).toBeNull();
  });

  test('returns token for session within idle timeout', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } }); // 1 hour
    const sid = makeSession('user1', 'tok-active');
    // Backdate to only 30 minutes ago (within 1-hour idle window)
    backdateLastActive(sid, 30 * 60 * 1000);
    expect(await getSession(repo, sid, currentConfig)).toBe('tok-active');
  });

  test('deletes idle-expired session so subsequent lookups also return null', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sid = makeSession('user1', 'tok-deleted');
    backdateLastActive(sid, 2 * ONE_HOUR_MS);

    // First call triggers deletion
    expect(await getSession(repo, sid, currentConfig)).toBeNull();
    // Second call confirms it's gone
    expect(await getSession(repo, sid, currentConfig)).toBeNull();
    // Raw memory check also confirms deletion
    expect(stores.memoryGetSession(sid)).toBeNull();
  });

  test('session without idle timeout is NOT affected by lastActiveAt', async () => {
    // no idleTimeout
    const sid = makeSession('user1', 'tok-no-idle');
    // Even backdating massively should not affect non-idle-timeout sessions
    backdateLastActive(sid, 365 * ONE_DAY_MS);
    expect(await getSession(repo, sid, DEFAULT_AUTH_CONFIG)).toBe('tok-no-idle');
  });
});

describe('getSessionByRefreshToken — idle timeout', () => {
  test('returns null for idle-expired session on refresh token lookup', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sid = makeSession('user1', 'tok-rt');
    stores.memorySetRefreshToken(sid, 'rt-expired');
    backdateLastActive(sid, 2 * ONE_HOUR_MS);

    expect(await getSessionByRefreshToken(repo, 'rt-expired', currentConfig)).toBeNull();
  });

  test('returns result when session is within idle timeout', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sid = makeSession('user1', 'tok-rt-active');
    stores.memorySetRefreshToken(sid, 'rt-active');
    backdateLastActive(sid, 30 * 60 * 1000); // 30 min ago

    const result = await getSessionByRefreshToken(repo, 'rt-active', currentConfig);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user1');
  });

  test('idle-expired session is deleted — cannot be resurrected', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sid = makeSession('user1', 'tok-rt-dead');
    stores.memorySetRefreshToken(sid, 'rt-dead');
    backdateLastActive(sid, 2 * ONE_HOUR_MS);

    expect(await getSessionByRefreshToken(repo, 'rt-dead', currentConfig)).toBeNull();
    // Session is gone from store
    expect(stores.memoryGetSession(sid)).toBeNull();
  });

  test('returns null for unknown refresh token regardless of idle timeout', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    expect(await getSessionByRefreshToken(repo, 'no-such-token', currentConfig)).toBeNull();
  });
});

describe('rotateRefreshToken — updates lastActiveAt', () => {
  test('lastActiveAt is updated after rotation', async () => {
    const sid = makeSession('user1', 'initial-token');
    stores.memorySetRefreshToken(sid, 'rt-original');

    // Backdate lastActiveAt to simulate idle period
    backdateLastActive(sid, ONE_HOUR_MS);
    const before = stores.memoryGetSessionRecord(sid)!.lastActiveAt;

    await Bun.sleep(5);
    await rotateRefreshToken(
      repo,
      sid,
      undefined,
      'rt-new',
      'new-access-token',
      DEFAULT_AUTH_CONFIG,
    );

    const after = stores.memoryGetSessionRecord(sid)!.lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  test('after rotation, previously idle session is no longer idle-expired', async () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sid = makeSession('user1', 'tok-rotate');
    stores.memorySetRefreshToken(sid, 'rt-before');

    // Backdate to just under idle timeout (simulate nearly-expired)
    backdateLastActive(sid, 3500 * 1000);

    // Rotate — this updates lastActiveAt to now
    await rotateRefreshToken(repo, sid, undefined, 'rt-after', 'new-access-token', currentConfig);

    // Session should now be accessible again (lastActiveAt reset)
    // Note: token is now "new-access-token" after rotation
    const record = stores.memoryGetSessionRecord(sid);
    expect(record).not.toBeNull();
    const idleSecs = (Date.now() - record!.lastActiveAt) / 1000;
    expect(idleSecs).toBeLessThan(60); // lastActiveAt is recent
  });
});

describe('absoluteTimeout — session TTL', () => {
  test('session uses default 7-day TTL when absoluteTimeout not configured', () => {
    const sid = makeSession('user1', 'tok-default');
    // Session should be accessible (well within 7 days)
    expect(stores.memoryGetSession(sid)).toBe('tok-default');
  });

  test('session uses custom absoluteTimeout', () => {
    currentConfig = createAuthResolvedConfig({ sessionPolicy: { absoluteTimeout: 3600 } }); // 1 hour
    stores = createMemoryAuthAdapter(() => currentConfig);
    repo = adapterAsRepo(stores);
    const sid = makeSession('user1', 'tok-1h');
    // Just created — should be accessible
    expect(stores.memoryGetSession(sid)).toBe('tok-1h');
  });

  test('config returns absoluteTimeout when set', () => {
    const cfg = createAuthResolvedConfig({ sessionPolicy: { absoluteTimeout: 1800 } });
    expect(cfg.sessionPolicy.absoluteTimeout).toBe(1800);
  });
});

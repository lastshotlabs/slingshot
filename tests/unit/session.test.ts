import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  type SessionRepository,
  atomicCreateSession,
  createMemorySessionRepository,
  createSession,
  deleteSession,
  deleteUserSessions,
  evictOldestSession,
  getActiveSessionCount,
  getSession,
  getSessionByRefreshToken,
  getUserSessions,
  rotateRefreshToken,
  setRefreshToken,
  updateSessionLastActive,
} from '@auth/lib/session';
import { beforeEach, describe, expect, test } from 'bun:test';

let config: AuthResolvedConfig;
let repo: SessionRepository;

beforeEach(() => {
  config = { ...DEFAULT_AUTH_CONFIG };
  repo = createMemorySessionRepository();
});

// ---------------------------------------------------------------------------
// createSession + getSession
// ---------------------------------------------------------------------------

describe('createSession + getSession', () => {
  test('creates a session and retrieves the token', async () => {
    await createSession(repo, 'user1', 'token-abc', 'sid-1', undefined, config);
    const token = await getSession(repo, 'sid-1', config);
    expect(token).toBe('token-abc');
  });

  test('returns null for non-existent sessionId', async () => {
    expect(await getSession(repo, 'unknown', config)).toBeNull();
  });

  test('stores session metadata', async () => {
    await createSession(
      repo,
      'user1',
      'token-abc',
      'sid-1',
      {
        ipAddress: '1.2.3.4',
        userAgent: 'TestAgent/1.0',
      },
      config,
    );
    const sessions = await getUserSessions(repo, 'user1', config);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ipAddress).toBe('1.2.3.4');
    expect(sessions[0].userAgent).toBe('TestAgent/1.0');
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  test('removes a session so getSession returns null', async () => {
    await createSession(repo, 'user1', 'token-abc', 'sid-1');
    await deleteSession(repo, 'sid-1');
    expect(await getSession(repo, 'sid-1')).toBeNull();
  });

  test('is idempotent — deleting twice does not throw', async () => {
    await createSession(repo, 'user1', 'token-abc', 'sid-1');
    await deleteSession(repo, 'sid-1');
    await deleteSession(repo, 'sid-1'); // no throw
    expect(await getSession(repo, 'sid-1')).toBeNull();
  });

  test('with persistSessionMetadata=false, fully removes session from store', async () => {
    config = { ...config, persistSessionMetadata: false };
    await createSession(repo, 'user1', 'token-abc', 'sid-1');
    expect(await getSession(repo, 'sid-1')).toBe('token-abc');
    await deleteSession(repo, 'sid-1');
    expect(await getSession(repo, 'sid-1')).toBeNull();
    // Session is fully removed — getUserSessions should return empty
    const sessions = await getUserSessions(repo, 'user1');
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getUserSessions
// ---------------------------------------------------------------------------

describe('getUserSessions', () => {
  test('returns empty array for unknown user', async () => {
    expect(await getUserSessions(repo, 'nobody')).toEqual([]);
  });

  test('returns all active sessions for a user', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    await createSession(repo, 'user1', 't2', 'sid-2');
    const sessions = await getUserSessions(repo, 'user1');
    expect(sessions).toHaveLength(2);
    expect(sessions.every(s => s.isActive)).toBe(true);
  });

  test('excludes deleted sessions by default', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    await createSession(repo, 'user1', 't2', 'sid-2');
    await deleteSession(repo, 'sid-1');
    const sessions = await getUserSessions(repo, 'user1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sid-2');
  });

  test('includes inactive sessions when configured', async () => {
    config = { ...config, includeInactiveSessions: true };
    await createSession(repo, 'user1', 't1', 'sid-1');
    await createSession(repo, 'user1', 't2', 'sid-2');
    await deleteSession(repo, 'sid-1');
    const sessions = await getUserSessions(repo, 'user1', config);
    expect(sessions).toHaveLength(2);
    const inactive = sessions.find(s => s.sessionId === 'sid-1');
    expect(inactive?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getActiveSessionCount
// ---------------------------------------------------------------------------

describe('getActiveSessionCount', () => {
  test('returns 0 for unknown user', async () => {
    expect(await getActiveSessionCount(repo, 'nobody')).toBe(0);
  });

  test('returns correct count with mixed active/deleted sessions', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    await createSession(repo, 'user1', 't2', 'sid-2');
    await createSession(repo, 'user1', 't3', 'sid-3');
    await deleteSession(repo, 'sid-2');
    expect(await getActiveSessionCount(repo, 'user1')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// evictOldestSession
// ---------------------------------------------------------------------------

describe('evictOldestSession', () => {
  test('evicts the session with the earliest createdAt', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    // small delay to ensure different createdAt
    await Bun.sleep(10);
    await createSession(repo, 'user1', 't2', 'sid-2');
    await evictOldestSession(repo, 'user1');
    expect(await getSession(repo, 'sid-1')).toBeNull();
    expect(await getSession(repo, 'sid-2')).toBe('t2');
  });

  test('no-op when user has no sessions', async () => {
    await evictOldestSession(repo, 'nobody'); // should not throw
  });
});

// ---------------------------------------------------------------------------
// deleteUserSessions
// ---------------------------------------------------------------------------

describe('deleteUserSessions', () => {
  test('deletes all sessions for a user', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    await createSession(repo, 'user1', 't2', 'sid-2');
    await deleteUserSessions(repo, 'user1');
    expect(await getSession(repo, 'sid-1')).toBeNull();
    expect(await getSession(repo, 'sid-2')).toBeNull();
  });

  test('works when user has zero sessions', async () => {
    await deleteUserSessions(repo, 'nobody'); // should not throw
  });
});

// ---------------------------------------------------------------------------
// updateSessionLastActive
// ---------------------------------------------------------------------------

describe('updateSessionLastActive', () => {
  test('updates lastActiveAt timestamp', async () => {
    await createSession(repo, 'user1', 't1', 'sid-1');
    const before = (await getUserSessions(repo, 'user1'))[0].lastActiveAt;
    await Bun.sleep(10);
    await updateSessionLastActive(repo, 'sid-1');
    const after = (await getUserSessions(repo, 'user1'))[0].lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  test('no-op for non-existent sessionId', async () => {
    await updateSessionLastActive(repo, 'unknown'); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Refresh token API
// ---------------------------------------------------------------------------

describe('setRefreshToken + getSessionByRefreshToken', () => {
  test('stores and looks up a refresh token', async () => {
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');
    const result = await getSessionByRefreshToken(repo, 'refresh-1');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');
    expect(result!.userId).toBe('user1');
  });

  test('returns null for unknown refresh token', async () => {
    expect(await getSessionByRefreshToken(repo, 'unknown')).toBeNull();
  });
});

describe('rotateRefreshToken', () => {
  test('moves current to prev and sets new token', async () => {
    config = { ...config, refreshToken: { rotationGraceSeconds: 30 } };
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');
    await rotateRefreshToken(repo, 'sid-1', undefined, 'refresh-2', 'access-2', config);

    // New token works
    const result = await getSessionByRefreshToken(repo, 'refresh-2');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');

    // Access token was updated
    const accessToken = await getSession(repo, 'sid-1');
    expect(accessToken).toBe('access-2');
  });

  test('previous token works within grace window', async () => {
    config = { ...config, refreshToken: { rotationGraceSeconds: 30 } };
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');
    await rotateRefreshToken(repo, 'sid-1', undefined, 'refresh-2', 'access-2', config);

    // Old token within grace window — session is found. newRefreshToken is the plain
    // Current token details stay server-side; callers only learn that this was a grace-window retry.
    const result = await getSessionByRefreshToken(repo, 'refresh-1');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');
    expect(result!.userId).toBe('user1');
    expect(result!.fromGrace).toBe(true);
  });

  test('previous token after grace window triggers theft detection', async () => {
    config = { ...config, refreshToken: { rotationGraceSeconds: 1 } };
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');
    await rotateRefreshToken(repo, 'sid-1', undefined, 'refresh-2', 'access-2', config);

    // Wait for grace window to expire
    await Bun.sleep(1100);

    // Old token after grace window → session deleted (theft detection)
    const result = await getSessionByRefreshToken(repo, 'refresh-1');
    expect(result).toBeNull();

    // Session should be invalidated
    expect(await getSession(repo, 'sid-1')).toBeNull();
  });

  test('atomic guard rejects rotation when old token does not match', async () => {
    config = { ...config, refreshToken: { rotationGraceSeconds: 30 } };
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');

    // Rotate with the correct old token — should succeed
    const first = await rotateRefreshToken(
      repo,
      'sid-1',
      'refresh-1',
      'refresh-2',
      'access-2',
      config,
    );
    expect(first).toBe(true);

    // Attempt to rotate again with the stale old token — should fail (concurrent guard)
    const second = await rotateRefreshToken(
      repo,
      'sid-1',
      'refresh-1',
      'refresh-3',
      'access-3',
      config,
    );
    expect(second).toBe(false);

    // Session still has refresh-2, not refresh-3
    const result = await getSessionByRefreshToken(repo, 'refresh-2');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');

    const stale = await getSessionByRefreshToken(repo, 'refresh-3');
    expect(stale).toBeNull();
  });

  test('atomic guard allows rotation when old token matches', async () => {
    config = { ...config, refreshToken: { rotationGraceSeconds: 30 } };
    await createSession(repo, 'user1', 'access-1', 'sid-1');
    await setRefreshToken(repo, 'sid-1', 'refresh-1');

    // Rotate with correct old token
    const rotated = await rotateRefreshToken(
      repo,
      'sid-1',
      'refresh-1',
      'refresh-2',
      'access-2',
      config,
    );
    expect(rotated).toBe(true);

    // Chain: rotate again with the new current token
    const rotated2 = await rotateRefreshToken(
      repo,
      'sid-1',
      'refresh-2',
      'refresh-3',
      'access-3',
      config,
    );
    expect(rotated2).toBe(true);

    const result = await getSessionByRefreshToken(repo, 'refresh-3');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');
  });
});

// ---------------------------------------------------------------------------
// atomicCreateSession (A-6)
// ---------------------------------------------------------------------------

describe('atomicCreateSession', () => {
  test('creates a session when under maxSessions limit', async () => {
    await atomicCreateSession(repo, 'user1', 'token-1', 'sid-1', 3);
    expect(await getSession(repo, 'sid-1')).toBe('token-1');
    expect(await getActiveSessionCount(repo, 'user1')).toBe(1);
  });

  test('creates sessions up to maxSessions without eviction', async () => {
    await atomicCreateSession(repo, 'user1', 't1', 'sid-1', 2);
    await Bun.sleep(10);
    await atomicCreateSession(repo, 'user1', 't2', 'sid-2', 2);
    expect(await getActiveSessionCount(repo, 'user1')).toBe(2);
    expect(await getSession(repo, 'sid-1')).toBe('t1');
    expect(await getSession(repo, 'sid-2')).toBe('t2');
  });

  test('evicts oldest session when at maxSessions limit', async () => {
    await atomicCreateSession(repo, 'user1', 't1', 'sid-1', 2);
    await Bun.sleep(10);
    await atomicCreateSession(repo, 'user1', 't2', 'sid-2', 2);
    await Bun.sleep(10);
    // This should evict sid-1 (oldest)
    await atomicCreateSession(repo, 'user1', 't3', 'sid-3', 2);

    expect(await getActiveSessionCount(repo, 'user1')).toBe(2);
    expect(await getSession(repo, 'sid-1')).toBeNull(); // evicted
    expect(await getSession(repo, 'sid-2')).toBe('t2');
    expect(await getSession(repo, 'sid-3')).toBe('t3');
  });

  test('evicts multiple oldest sessions when maxSessions is 1', async () => {
    // Pre-create 3 sessions using plain createSession
    await createSession(repo, 'user1', 't1', 'sid-1');
    await Bun.sleep(10);
    await createSession(repo, 'user1', 't2', 'sid-2');
    await Bun.sleep(10);
    await createSession(repo, 'user1', 't3', 'sid-3');

    expect(await getActiveSessionCount(repo, 'user1')).toBe(3);

    // atomicCreateSession with maxSessions=1 should evict all 3 and create the new one
    await Bun.sleep(10);
    await atomicCreateSession(repo, 'user1', 't4', 'sid-4', 1);

    expect(await getActiveSessionCount(repo, 'user1')).toBe(1);
    expect(await getSession(repo, 'sid-1')).toBeNull();
    expect(await getSession(repo, 'sid-2')).toBeNull();
    expect(await getSession(repo, 'sid-3')).toBeNull();
    expect(await getSession(repo, 'sid-4')).toBe('t4');
  });

  test('stores session metadata', async () => {
    await atomicCreateSession(repo, 'user1', 't1', 'sid-1', 5, {
      ipAddress: '10.0.0.1',
      userAgent: 'AtomicTest/1.0',
    });
    const sessions = await getUserSessions(repo, 'user1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ipAddress).toBe('10.0.0.1');
    expect(sessions[0].userAgent).toBe('AtomicTest/1.0');
  });
});

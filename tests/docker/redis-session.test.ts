import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import {
  createRedisSessionRepository,
  createSession,
  deleteSession,
  evictOldestSession,
  getActiveSessionCount,
  getSession,
  getSessionByRefreshToken,
  getUserSessions,
  rotateRefreshToken,
  setRefreshToken,
  updateSessionLastActive,
} from '@auth/lib/session';
import type { SessionRepository } from '@auth/lib/session';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  connectTestRedis,
  disconnectTestServices,
  flushTestServices,
  getTestRedis,
} from '../setup-docker';

let repo: SessionRepository;

const makeConfig = (patch: Partial<AuthResolvedConfig> = {}): AuthResolvedConfig => ({
  ...DEFAULT_AUTH_CONFIG,
  appName: 'test-app',
  ...patch,
});

beforeAll(async () => {
  await connectTestRedis();
  repo = createRedisSessionRepository(() => getTestRedis(), 'test-app');
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe('Redis session store', () => {
  it('creates and retrieves a session', async () => {
    await createSession(repo, 'user-1', 'jwt-token-1', 'sess-1', {
      ipAddress: '127.0.0.1',
      userAgent: 'TestAgent',
    });
    const token = await getSession(repo, 'sess-1');
    expect(token).toBe('jwt-token-1');
  });

  it('returns null for non-existent session', async () => {
    expect(await getSession(repo, 'nope')).toBeNull();
  });

  it('deletes a session', async () => {
    await createSession(repo, 'user-1', 'jwt-token-1', 'sess-del');
    await deleteSession(repo, 'sess-del');
    expect(await getSession(repo, 'sess-del')).toBeNull();
  });

  it('lists user sessions', async () => {
    await createSession(repo, 'user-list', 't1', 'sess-a', { ipAddress: '1.1.1.1' });
    await createSession(repo, 'user-list', 't2', 'sess-b', { userAgent: 'Agent2' });

    const sessions = await getUserSessions(repo, 'user-list');
    expect(sessions).toHaveLength(2);
    expect(sessions.every(s => s.isActive)).toBe(true);
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('counts active sessions', async () => {
    await createSession(repo, 'user-count', 't1', 's1');
    await createSession(repo, 'user-count', 't2', 's2');
    expect(await getActiveSessionCount(repo, 'user-count')).toBe(2);

    await deleteSession(repo, 's1');
    expect(await getActiveSessionCount(repo, 'user-count')).toBe(1);
  });

  it('evicts oldest session', async () => {
    await createSession(repo, 'user-evict', 't1', 'oldest');
    // Small delay to ensure different createdAt
    await new Promise(r => setTimeout(r, 50));
    await createSession(repo, 'user-evict', 't2', 'newest');

    await evictOldestSession(repo, 'user-evict');
    expect(await getSession(repo, 'oldest')).toBeNull();
    expect(await getSession(repo, 'newest')).toBe('t2');
  });

  it('updates lastActiveAt', async () => {
    await createSession(repo, 'user-active', 't1', 'sess-active');
    const before = (await getUserSessions(repo, 'user-active'))[0].lastActiveAt;
    await new Promise(r => setTimeout(r, 50));
    await updateSessionLastActive(repo, 'sess-active');
    const after = (await getUserSessions(repo, 'user-active'))[0].lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  it('includes metadata in session info', async () => {
    await createSession(repo, 'user-meta', 't1', 'sess-meta', {
      ipAddress: '10.0.0.1',
      userAgent: 'Chrome/100',
    });
    const sessions = await getUserSessions(repo, 'user-meta');
    expect(sessions[0].ipAddress).toBe('10.0.0.1');
    expect(sessions[0].userAgent).toBe('Chrome/100');
  });

  // -----------------------------------------------------------------------
  // Refresh tokens
  // -----------------------------------------------------------------------

  describe('refresh tokens', () => {
    const rtConfig = makeConfig({
      refreshToken: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 30,
      },
    });

    it('sets and retrieves by refresh token', async () => {
      await createSession(repo, 'user-rt', 'access-1', 'sess-rt');
      await setRefreshToken(repo, 'sess-rt', 'refresh-1');

      const result = await getSessionByRefreshToken(repo, 'refresh-1', rtConfig);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-rt');
      expect(result!.userId).toBe('user-rt');
    });

    it('returns null for unknown refresh token', async () => {
      expect(await getSessionByRefreshToken(repo, 'unknown', rtConfig)).toBeNull();
    });

    it('rotates refresh token with grace window', async () => {
      await createSession(repo, 'user-rotate', 'access-old', 'sess-rotate');
      await setRefreshToken(repo, 'sess-rotate', 'refresh-old');
      await rotateRefreshToken(
        repo,
        'sess-rotate',
        'refresh-old',
        'refresh-new',
        'access-new',
        rtConfig,
      );

      // New token works
      const newResult = await getSessionByRefreshToken(repo, 'refresh-new', rtConfig);
      expect(newResult).not.toBeNull();
      expect(newResult!.sessionId).toBe('sess-rotate');

      // Old token works within grace window
      const graceResult = await getSessionByRefreshToken(repo, 'refresh-old', rtConfig);
      expect(graceResult).not.toBeNull();
      expect(graceResult!.fromGrace).toBe(true);
    });

    it('detects theft when old token used after grace window', async () => {
      const noGraceConfig = makeConfig({
        refreshToken: {
          accessTokenExpiry: 900,
          refreshTokenExpiry: 86400,
          rotationGraceSeconds: 0,
        },
      });

      await createSession(repo, 'user-theft', 'access-1', 'sess-theft');
      await setRefreshToken(repo, 'sess-theft', 'rt-original');
      await rotateRefreshToken(
        repo,
        'sess-theft',
        'rt-original',
        'rt-rotated',
        'access-2',
        noGraceConfig,
      );

      // Wait a tick so grace window (0s) expires
      await new Promise(r => setTimeout(r, 50));

      // Old token used after grace → session invalidated
      const result = await getSessionByRefreshToken(repo, 'rt-original', noGraceConfig);
      expect(result).toBeNull();

      // Session should be deleted (theft detection)
      expect(await getSession(repo, 'sess-theft')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Persist metadata mode
  // -----------------------------------------------------------------------

  describe('persist metadata mode', () => {
    const persistConfig = makeConfig({ persistSessionMetadata: true });

    it('soft-deletes session (nulls token, keeps record)', async () => {
      await createSession(repo, 'user-persist', 't1', 'sess-persist');
      await deleteSession(repo, 'sess-persist', persistConfig);

      // Token should be null (not returned by getSession)
      expect(await getSession(repo, 'sess-persist')).toBeNull();
    });
  });
});

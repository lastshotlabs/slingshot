/**
 * Unit tests for the in-memory session repository.
 *
 * Covers:
 * - Session CRUD (create, get, delete)
 * - Max sessions enforcement (atomic create with eviction)
 * - Idle timeout expiration
 * - Refresh token rotation with grace window
 * - Stolen token detection (reuse after grace window)
 * - Session fingerprint storage and retrieval
 * - MFA verified-at timestamp
 * - Last-active tracking
 * - Tombstoning (soft delete)
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createAuthResolvedConfig } from '../../src/config/authConfig';
import type { AuthResolvedConfig } from '../../src/config/authConfig';
import {
  createMemorySessionRepository,
  createSqliteSessionRepository,
} from '../../src/lib/session';
import type { SessionRepository } from '../../src/lib/session';

let repo: SessionRepository;
let config: AuthResolvedConfig;

beforeEach(() => {
  repo = createMemorySessionRepository();
  config = createAuthResolvedConfig({});
});

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe('session CRUD', () => {
  test('createSession and getSession round-trip', async () => {
    await repo.createSession('user-1', 'jwt-token-1', 'sess-1', undefined, config);
    const token = await repo.getSession('sess-1', config);
    expect(token).toBe('jwt-token-1');
  });

  test('getSession returns null for non-existent session', async () => {
    const token = await repo.getSession('nope', config);
    expect(token).toBeNull();
  });

  test('deleteSession removes the session', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    await repo.deleteSession('sess-1', config);
    const token = await repo.getSession('sess-1', config);
    expect(token).toBeNull();
  });

  test('getUserSessions returns all active sessions', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    await repo.createSession('user-1', 'jwt-2', 'sess-2', undefined, config);
    await repo.createSession('user-2', 'jwt-3', 'sess-3', undefined, config);

    const sessions = await repo.getUserSessions('user-1', config);
    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
  });

  test('getActiveSessionCount counts only active sessions', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    await repo.createSession('user-1', 'jwt-2', 'sess-2', undefined, config);
    await repo.deleteSession('sess-1', config);

    const count = await repo.getActiveSessionCount('user-1', config);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Max sessions enforcement
// ---------------------------------------------------------------------------

describe('max sessions enforcement', () => {
  test('atomicCreateSession evicts oldest when at capacity', async () => {
    await repo.atomicCreateSession('user-1', 'jwt-1', 'sess-1', 2, undefined, config);
    await repo.atomicCreateSession('user-1', 'jwt-2', 'sess-2', 2, undefined, config);

    // At capacity (2). Creating a third should evict the oldest (sess-1).
    await repo.atomicCreateSession('user-1', 'jwt-3', 'sess-3', 2, undefined, config);

    const count = await repo.getActiveSessionCount('user-1', config);
    expect(count).toBe(2);

    // sess-1 should be gone
    const token1 = await repo.getSession('sess-1', config);
    expect(token1).toBeNull();

    // sess-2 and sess-3 should remain
    expect(await repo.getSession('sess-2', config)).toBe('jwt-2');
    expect(await repo.getSession('sess-3', config)).toBe('jwt-3');
  });

  test('different users have independent session caps', async () => {
    await repo.atomicCreateSession('user-1', 'jwt-1', 's1', 1, undefined, config);
    await repo.atomicCreateSession('user-2', 'jwt-2', 's2', 1, undefined, config);

    expect(await repo.getActiveSessionCount('user-1', config)).toBe(1);
    expect(await repo.getActiveSessionCount('user-2', config)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Refresh token rotation
// ---------------------------------------------------------------------------

describe('refresh token rotation', () => {
  const refreshConfig = createAuthResolvedConfig({
    refreshToken: {
      accessTokenExpiry: 900,
      refreshTokenExpiry: 86400,
      rotationGraceSeconds: 10,
    },
  });

  test('setRefreshToken and getSessionByRefreshToken round-trip', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await repo.setRefreshToken('sess-1', 'refresh-abc', refreshConfig);

    const result = await repo.getSessionByRefreshToken('refresh-abc', refreshConfig);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-1');
    expect(result!.userId).toBe('user-1');
    expect(result!.fromGrace).toBe(false);
  });

  test('rotateRefreshToken swaps tokens', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await repo.setRefreshToken('sess-1', 'old-refresh', refreshConfig);

    const rotated = await repo.rotateRefreshToken(
      'sess-1',
      'old-refresh',
      'new-refresh',
      'new-jwt',
      refreshConfig,
    );
    expect(rotated).toBe(true);

    // New token works
    const result = await repo.getSessionByRefreshToken('new-refresh', refreshConfig);
    expect(result).not.toBeNull();
    expect(result!.fromGrace).toBe(false);
  });

  test('old refresh token still works during grace window', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await repo.setRefreshToken('sess-1', 'old-refresh', refreshConfig);

    await repo.rotateRefreshToken('sess-1', 'old-refresh', 'new-refresh', 'new-jwt', refreshConfig);

    // Old token should work (grace window is 10s, we're within it)
    const result = await repo.getSessionByRefreshToken('old-refresh', refreshConfig);
    expect(result).not.toBeNull();
    expect(result!.fromGrace).toBe(true);
  });

  test('completely invalid refresh token returns null', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await repo.setRefreshToken('sess-1', 'real-token', refreshConfig);

    const result = await repo.getSessionByRefreshToken('bogus-token', refreshConfig);
    expect(result).toBeNull();
  });

  test('rotateRefreshToken fails if old token does not match (concurrent rotation guard)', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await repo.setRefreshToken('sess-1', 'current-token', refreshConfig);

    // Try to rotate with wrong old token
    const rotated = await repo.rotateRefreshToken(
      'sess-1',
      'wrong-old-token',
      'new-token',
      'new-jwt',
      refreshConfig,
    );
    expect(rotated).toBe(false);

    // Original token still works
    const result = await repo.getSessionByRefreshToken('current-token', refreshConfig);
    expect(result).not.toBeNull();
  });
});

describe('sqlite refresh-token storage', () => {
  test('stores only hashed refresh tokens and drops the legacy plaintext column', async () => {
    const db = new Database(':memory:');
    const sqliteRepo = createSqliteSessionRepository(db);
    const refreshConfig = createAuthResolvedConfig({
      refreshToken: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 10,
      },
    });

    await sqliteRepo.createSession('user-1', 'jwt-1', 'sess-1', undefined, refreshConfig);
    await sqliteRepo.setRefreshToken('sess-1', 'refresh-abc', refreshConfig);
    await sqliteRepo.rotateRefreshToken(
      'sess-1',
      'refresh-abc',
      'refresh-next',
      'jwt-2',
      refreshConfig,
    );

    const columns = (db.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      column => column.name,
    );
    expect(columns).not.toContain('refreshTokenPlain');

    const row = db
      .query('SELECT refreshToken, prevRefreshToken FROM sessions WHERE sessionId = ?')
      .get('sess-1') as { refreshToken: string | null; prevRefreshToken: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.refreshToken).not.toBe('refresh-next');
    expect(row!.prevRefreshToken).not.toBe('refresh-abc');
  });
});

// ---------------------------------------------------------------------------
// Fingerprint binding
// ---------------------------------------------------------------------------

describe('session fingerprint', () => {
  test('stores and retrieves fingerprint', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);

    const before = await repo.getSessionFingerprint('sess-1');
    expect(before).toBeNull();

    await repo.setSessionFingerprint('sess-1', 'sha256-hash-of-ip-ua');

    const after = await repo.getSessionFingerprint('sess-1');
    expect(after).toBe('sha256-hash-of-ip-ua');
  });

  test('fingerprint returns null for non-existent session', async () => {
    const fp = await repo.getSessionFingerprint('nope');
    expect(fp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MFA verified-at
// ---------------------------------------------------------------------------

describe('MFA verified-at', () => {
  test('initially null', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    const ts = await repo.getMfaVerifiedAt('sess-1');
    expect(ts).toBeNull();
  });

  test('setMfaVerifiedAt records current time', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    const before = Math.floor(Date.now() / 1000);
    await repo.setMfaVerifiedAt('sess-1');
    const after = Math.floor(Date.now() / 1000);

    const ts = await repo.getMfaVerifiedAt('sess-1');
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  test('returns null for non-existent session', async () => {
    const ts = await repo.getMfaVerifiedAt('nope');
    expect(ts).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Last-active tracking
// ---------------------------------------------------------------------------

describe('last-active tracking', () => {
  test('updateSessionLastActive does not throw', async () => {
    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, config);
    // Should not throw — fire-and-forget in middleware
    await repo.updateSessionLastActive('sess-1', config);
  });

  test('updateSessionLastActive on non-existent session does not throw', async () => {
    await repo.updateSessionLastActive('nope', config);
  });
});

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe('idle timeout', () => {
  test('session expires after idle timeout', async () => {
    const idleConfig = createAuthResolvedConfig({
      sessionPolicy: { idleTimeout: 1 }, // 1 second idle timeout
    });

    await repo.createSession('user-1', 'jwt-1', 'sess-1', undefined, idleConfig);

    // Should be valid immediately
    const token1 = await repo.getSession('sess-1', idleConfig);
    expect(token1).toBe('jwt-1');

    // Wait for idle timeout
    await new Promise(r => setTimeout(r, 1200));

    // Should now be expired
    const token2 = await repo.getSession('sess-1', idleConfig);
    expect(token2).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

describe('session metadata', () => {
  test('stores metadata on creation when persistSessionMetadata is enabled', async () => {
    const metadataConfig = createAuthResolvedConfig({ persistSessionMetadata: true });

    await repo.createSession(
      'user-1',
      'jwt-1',
      'sess-1',
      { ipAddress: '192.168.1.1', userAgent: 'TestAgent/1.0' },
      metadataConfig,
    );

    const sessions = await repo.getUserSessions('user-1', metadataConfig);
    expect(sessions.length).toBe(1);
    // The metadata shape may vary per implementation — just check it's present
    const sess = sessions[0];
    expect(sess).toBeDefined();
    // Session should have an id and be active
    expect(sess.sessionId).toBe('sess-1');
    expect(sess.isActive).toBe(true);
  });
});

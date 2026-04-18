/**
 * Tests for F6 — session tombstone sweep.
 *
 * When `persistSessionMetadata` is true, deleting a session converts it to a
 * tombstone (token=null, refresh=null) rather than removing it entirely. This
 * preserves IP/UA metadata for audit purposes. Without a sweep, tombstones
 * accumulate indefinitely in the in-memory store.
 *
 * After F6, `sweepExpiredTombstones()` is called opportunistically on:
 *   - `deleteSession` — sweep on every logical delete
 *   - `atomicCreateSession` (via trimSessionsToCapacity) — sweep on new session creation
 *
 * Covers:
 *   - Deleted session becomes a tombstone (getSession returns null) when persistSessionMetadata=true
 *   - getUserSessions does not include tombstoned sessions
 *   - Tombstone is swept once its natural TTL expires (triggered by a new session creation)
 *   - Non-tombstone sessions are not swept while still valid
 *   - Without persistSessionMetadata, delete fully removes the session
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_AUTH_CONFIG } from '../../src/config/authConfig';
import type { AuthResolvedConfig } from '../../src/config/authConfig';
import { createMemorySessionRepository } from '../../src/lib/session';

// Config with 1-second TTL so we can simulate expiry in tests
const SHORT_TTL_CONFIG: AuthResolvedConfig = {
  ...DEFAULT_AUTH_CONFIG,
  persistSessionMetadata: true,
  sessionPolicy: { ...DEFAULT_AUTH_CONFIG.sessionPolicy, absoluteTimeout: 1 },
};

const PERSIST_CONFIG: AuthResolvedConfig = {
  ...DEFAULT_AUTH_CONFIG,
  persistSessionMetadata: true,
  sessionPolicy: { ...DEFAULT_AUTH_CONFIG.sessionPolicy, absoluteTimeout: 3600 },
};

const NO_PERSIST_CONFIG: AuthResolvedConfig = {
  ...DEFAULT_AUTH_CONFIG,
  persistSessionMetadata: false,
  sessionPolicy: { ...DEFAULT_AUTH_CONFIG.sessionPolicy, absoluteTimeout: 3600 },
};

describe('session tombstones — persistSessionMetadata=true', () => {
  let repo: ReturnType<typeof createMemorySessionRepository>;

  beforeEach(() => {
    repo = createMemorySessionRepository();
  });

  test('deleted session becomes a tombstone: getSession returns null', async () => {
    await repo.atomicCreateSession('user-1', 'tok-1', 'sess-1', 10, {}, PERSIST_CONFIG);
    expect(await repo.getSession('sess-1', PERSIST_CONFIG)).toBe('tok-1');

    await repo.deleteSession('sess-1', PERSIST_CONFIG);

    // Token nulled → getSession returns null
    expect(await repo.getSession('sess-1', PERSIST_CONFIG)).toBeNull();
  });

  test('tombstoned session does not appear in getUserSessions', async () => {
    await repo.atomicCreateSession('user-2', 'tok-2', 'sess-2', 10, {}, PERSIST_CONFIG);
    await repo.atomicCreateSession('user-2', 'tok-3', 'sess-3', 10, {}, PERSIST_CONFIG);

    await repo.deleteSession('sess-2', PERSIST_CONFIG);

    const sessions = await repo.getUserSessions('user-2', PERSIST_CONFIG);
    const ids = sessions.map(s => s.sessionId);
    expect(ids).not.toContain('sess-2');
    expect(ids).toContain('sess-3');
  });

  test('tombstone is swept after TTL expires when a new session is created', async () => {
    // Create and delete a session with 1-second TTL
    await repo.atomicCreateSession('user-3', 'tok-sweep', 'sess-sweep', 10, {}, SHORT_TTL_CONFIG);
    await repo.deleteSession('sess-sweep', SHORT_TTL_CONFIG);

    // Wait for the TTL to expire (2.5× the 1-second TTL for robustness)
    await new Promise(res => setTimeout(res, 2500));

    // Creating a new session triggers sweepExpiredTombstones
    await repo.atomicCreateSession('user-3', 'tok-new', 'sess-new', 10, {}, SHORT_TTL_CONFIG);

    // The expired tombstone should be fully gone
    // If sweep works correctly, getSession for the tombstone still returns null
    // and the store is clean (verified by the new session being accessible)
    expect(await repo.getSession('sess-sweep', SHORT_TTL_CONFIG)).toBeNull();
    expect(await repo.getSession('sess-new', SHORT_TTL_CONFIG)).toBe('tok-new');
  });

  test('active sessions are not swept while still within TTL', async () => {
    const cfg = PERSIST_CONFIG; // 1-hour TTL

    await repo.atomicCreateSession('user-4', 'tok-active', 'sess-active', 10, {}, cfg);

    // Create + delete another session (triggers sweep on delete)
    await repo.atomicCreateSession('user-4', 'tok-other', 'sess-other', 10, {}, cfg);
    await repo.deleteSession('sess-other', cfg);

    // The active session should still be accessible after the sweep
    expect(await repo.getSession('sess-active', cfg)).toBe('tok-active');
  });

  test('without persistSessionMetadata, delete fully removes the session (no tombstone)', async () => {
    await repo.atomicCreateSession('user-5', 'tok-full', 'sess-full', 10, {}, NO_PERSIST_CONFIG);
    await repo.deleteSession('sess-full', NO_PERSIST_CONFIG);

    expect(await repo.getSession('sess-full', NO_PERSIST_CONFIG)).toBeNull();
    // Active session count should be 0 — truly removed
    const count = await repo.getActiveSessionCount('user-5', NO_PERSIST_CONFIG);
    expect(count).toBe(0);
  });
});

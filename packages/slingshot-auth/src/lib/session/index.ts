import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import type { SessionRepository } from './repository';
import type { RefreshResult, SessionInfo, SessionMetadata } from './types';

// ---------------------------------------------------------------------------
// Types — canonical definitions live in ../../types/session.ts
// ---------------------------------------------------------------------------

export type { SessionMetadata, SessionInfo, RefreshResult } from './types';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export type { SessionRepository } from './repository';

// ---------------------------------------------------------------------------
// Backend factories
// ---------------------------------------------------------------------------

export { createMemorySessionRepository } from './memoryStore';
export { createSqliteSessionRepository } from './sqliteStore';
export { createRedisSessionRepository } from './redisStore';
export { createMongoSessionRepository } from './mongoStore';
export { createPostgresSessionRepository } from './postgresStore';

// ---------------------------------------------------------------------------
// Factory dispatch map
// ---------------------------------------------------------------------------

export { sessionFactories } from './factories';

// ---------------------------------------------------------------------------
// Public API — thin wrappers delegating to SessionRepository
//
// Callers pass the repo directly (resolved in bootstrap via sessionFactories).
// ---------------------------------------------------------------------------

/**
 * Stores a new session for a user. No capacity enforcement — use `atomicCreateSession`
 * (via `createSessionForUser`) when you want oldest-session eviction.
 *
 * @param repo - The active session repository.
 * @param userId - The authenticated user's ID.
 * @param token - The raw JWT to store.
 * @param sessionId - A unique session identifier (UUID recommended).
 * @param metadata - Optional IP address and user-agent for session listing.
 * @param config - Resolved auth config controlling TTL. Defaults to `DEFAULT_AUTH_CONFIG`.
 *
 * @example
 * await createSession(runtime.repos.session, userId, jwtToken, crypto.randomUUID(), {
 *   ipAddress: req.headers.get('x-forwarded-for') ?? undefined,
 *   userAgent: req.headers.get('user-agent') ?? undefined,
 * });
 */
export const createSession = async (
  repo: SessionRepository,
  userId: string,
  token: string,
  sessionId: string,
  metadata?: SessionMetadata,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.createSession(userId, token, sessionId, metadata, config);
};

export const atomicCreateSession = async (
  repo: SessionRepository,
  userId: string,
  token: string,
  sessionId: string,
  maxSessions: number,
  metadata?: SessionMetadata,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.atomicCreateSession(userId, token, sessionId, maxSessions, metadata, config);
};

/**
 * Retrieves the JWT token for an active, non-expired session.
 *
 * Returns `null` if the session does not exist, has expired, or has exceeded the
 * configured idle timeout. The idle check is enforced inline — an expired-by-idle
 * session is deleted and `null` is returned.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session ID to look up.
 * @param config - Resolved auth config controlling idle timeout. Defaults to `DEFAULT_AUTH_CONFIG`.
 * @returns The stored JWT string, or `null` if the session is absent/expired.
 *
 * @example
 * const token = await getSession(runtime.repos.session, payload.sid!, runtime.config);
 * if (!token) return c.json({ error: 'Session expired' }, 401);
 */
export const getSession = async (
  repo: SessionRepository,
  sessionId: string,
  config?: AuthResolvedConfig,
): Promise<string | null> => {
  const cfg = config ?? DEFAULT_AUTH_CONFIG;
  return repo.getSession(sessionId, cfg);
};

/**
 * Deletes (or tombstones) a single session.
 *
 * When `config.persistSessionMetadata` is `true`, the session token and refresh tokens
 * are nulled out but the metadata row is retained for auditing. Otherwise the row is
 * deleted entirely.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session ID to delete.
 * @param config - Resolved auth config controlling tombstone vs. full-delete behavior.
 *
 * @example
 * // Logout: delete the current session
 * await deleteSession(runtime.repos.session, sessionId, runtime.config);
 */
export const deleteSession = async (
  repo: SessionRepository,
  sessionId: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.deleteSession(sessionId, config);
};

/**
 * Lists sessions for a user, filtered by the active/inactive policy in `config`.
 *
 * Active sessions have a non-null token and have not expired. Inactive sessions are
 * included only when `config.includeInactiveSessions` is `true` and
 * `config.persistSessionMetadata` is `true`.
 *
 * @param repo - The active session repository.
 * @param userId - The user whose sessions to fetch.
 * @param config - Resolved auth config controlling which sessions are returned.
 * @returns An array of `SessionInfo` objects ordered by creation time (oldest first).
 *
 * @example
 * const sessions = await getUserSessions(runtime.repos.session, userId, runtime.config);
 * // sessions: [{ sessionId, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent, isActive }]
 */
export const getUserSessions = async (
  repo: SessionRepository,
  userId: string,
  config?: AuthResolvedConfig,
): Promise<SessionInfo[]> => {
  return repo.getUserSessions(userId, config);
};

/**
 * Returns the number of currently active sessions for a user.
 *
 * @param repo - The active session repository.
 * @param userId - The user to count sessions for.
 * @param config - Resolved auth config (used for TTL checks in some backends).
 * @returns The count of non-expired, non-deleted sessions.
 *
 * @example
 * const count = await getActiveSessionCount(runtime.repos.session, userId, runtime.config);
 */
export const getActiveSessionCount = async (
  repo: SessionRepository,
  userId: string,
  config?: AuthResolvedConfig,
): Promise<number> => {
  return repo.getActiveSessionCount(userId, config);
};

/**
 * Deletes the oldest active session for a user.
 *
 * Used internally by the session capacity enforcement path when the per-user session
 * limit (`maxSessions`) would be exceeded by a new login.
 *
 * @param repo - The active session repository.
 * @param userId - The user whose oldest session to evict.
 * @param config - Resolved auth config controlling tombstone vs. delete behavior.
 *
 * @example
 * await evictOldestSession(runtime.repos.session, userId, runtime.config);
 */
export const evictOldestSession = async (
  repo: SessionRepository,
  userId: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.evictOldestSession(userId, config);
};

export const deleteUserSessions = async (
  repo: SessionRepository,
  userId: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  const sessions = await repo.getUserSessions(userId, config);
  await Promise.all(sessions.map(s => repo.deleteSession(s.sessionId, config)));
};

export const deleteOtherSessions = async (
  repo: SessionRepository,
  userId: string,
  currentSessionId: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  const sessions = await repo.getUserSessions(userId, config);
  const others = sessions.filter(s => s.sessionId !== currentSessionId);
  await Promise.all(others.map(s => repo.deleteSession(s.sessionId, config)));
};

/**
 * Updates the `lastActiveAt` timestamp for a session.
 *
 * Called on every authenticated request when `config.trackLastActive` is enabled,
 * and automatically by `rotateRefreshToken`. Required for idle-timeout enforcement
 * (`config.sessionPolicy.idleTimeout`).
 *
 * @param repo - The active session repository.
 * @param sessionId - The session to touch.
 * @param config - Resolved auth config.
 *
 * @example
 * // Touch the session after a verified request
 * await updateSessionLastActive(runtime.repos.session, sessionId, runtime.config);
 */
export const updateSessionLastActive = async (
  repo: SessionRepository,
  sessionId: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.updateSessionLastActive(sessionId, config);
};

/**
 * Associates a refresh token with an existing session.
 *
 * The token is stored hashed (SHA-256). The plain value is never persisted after
 * this point — the caller must return it to the client immediately.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session to associate the token with.
 * @param refreshToken - The plain (unhashed) refresh token to store.
 * @param config - Resolved auth config (used for TTL in some backends).
 *
 * @example
 * const refreshToken = crypto.randomUUID();
 * await setRefreshToken(runtime.repos.session, sessionId, refreshToken, runtime.config);
 */
export const setRefreshToken = async (
  repo: SessionRepository,
  sessionId: string,
  refreshToken: string,
  config?: AuthResolvedConfig,
): Promise<void> => {
  await repo.setRefreshToken(sessionId, refreshToken, config);
};

/**
 * Looks up a session by its refresh token, supporting a short grace window after rotation.
 *
 * Returns `null` if the token is unknown, expired, or has been superseded by more than
 * the configured grace period (`config.refreshToken.rotationGraceSeconds`).
 *
 * If the token matches the *previous* (rotated-away) token and is still within the grace
 * window, `fromGrace: true` is set on the result — the caller should re-issue the current
 * token rather than rotating again.
 *
 * @param repo - The active session repository.
 * @param refreshToken - The plain refresh token received from the client.
 * @param config - Resolved auth config controlling idle timeout and grace window.
 * @returns A `RefreshResult` with session/user IDs and grace-window metadata, or `null`.
 *
 * @example
 * const result = await getSessionByRefreshToken(runtime.repos.session, clientToken, runtime.config);
 * if (!result) return c.json({ error: 'Invalid refresh token' }, 401);
 */
export const getSessionByRefreshToken = async (
  repo: SessionRepository,
  refreshToken: string,
  config?: AuthResolvedConfig,
): Promise<RefreshResult | null> => {
  return repo.getSessionByRefreshToken(refreshToken, config);
};

/**
 * Atomically rotates a refresh token: issues a new token, archives the old one into a
 * short grace window, and updates the access token stored in the session.
 *
 * Implements a concurrent-request guard: if `oldRefreshToken` is provided, the rotation
 * only succeeds when the session's current token still matches — preventing double-rotation
 * race conditions. Pass `undefined` for `oldRefreshToken` when re-rotating from within
 * the grace window (the guard is skipped).
 *
 * On success, also updates `lastActiveAt` on the session.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session to rotate tokens for.
 * @param oldRefreshToken - The client's current refresh token (plain). Pass `undefined` for grace-window re-rotations.
 * @param newRefreshToken - The new refresh token to issue (plain).
 * @param newAccessToken - The new JWT access token.
 * @param config - Resolved auth config controlling the grace period.
 * @returns `true` if the rotation succeeded, `false` if the guard failed (already rotated by a concurrent request).
 *
 * @example
 * const newRefresh = crypto.randomUUID();
 * const newJwt = await signToken({ sub: userId, sid: sessionId }, 900, config, signing);
 * const rotated = await rotateRefreshToken(
 *   runtime.repos.session, sessionId, oldToken, newRefresh, newJwt, runtime.config,
 * );
 * if (!rotated) return c.json({ error: 'Concurrent token refresh detected' }, 409);
 */
export const rotateRefreshToken = async (
  repo: SessionRepository,
  sessionId: string,
  oldRefreshToken: string | undefined,
  newRefreshToken: string,
  newAccessToken: string,
  config?: AuthResolvedConfig,
): Promise<boolean> => {
  const rotated = await repo.rotateRefreshToken(
    sessionId,
    oldRefreshToken,
    newRefreshToken,
    newAccessToken,
    config,
  );
  if (rotated) await repo.updateSessionLastActive(sessionId, config);
  return rotated;
};

/**
 * Retrieves the stored session fingerprint, or `null` if none is set.
 *
 * The fingerprint is a SHA-256 hash of the client's binding fields (IP address,
 * user-agent, etc.) configured via `signing.sessionBinding`. It is set at session
 * creation time and re-verified on every authenticated request.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session ID to look up.
 * @returns The stored fingerprint string, or `null`.
 *
 * @example
 * const stored = await getSessionFingerprint(runtime.repos.session, sessionId);
 */
export const getSessionFingerprint = async (
  repo: SessionRepository,
  sessionId: string,
): Promise<string | null> => {
  return repo.getSessionFingerprint(sessionId);
};

/**
 * Stores a session fingerprint for subsequent binding verification.
 *
 * Called at session creation time (with fields derivable from session metadata) and
 * on the first authenticated request when runtime fields like `Accept-Language` are needed.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session ID to store the fingerprint for.
 * @param fingerprint - SHA-256 hash of the client's binding fields.
 *
 * @example
 * const fingerprint = sha256([ip, userAgent].join(':'));
 * await setSessionFingerprint(runtime.repos.session, sessionId, fingerprint);
 */
export const setSessionFingerprint = async (
  repo: SessionRepository,
  sessionId: string,
  fingerprint: string,
): Promise<void> => {
  await repo.setSessionFingerprint(sessionId, fingerprint);
};

/**
 * Marks the current time as the MFA verification timestamp for a session.
 *
 * Used by step-up auth and MFA flows to record when the user last completed a
 * second-factor challenge. The timestamp (Unix epoch seconds) is compared against
 * `config.stepUp.maxAge` on protected routes.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session to stamp.
 *
 * @example
 * // After a successful TOTP or WebAuthn verification
 * await setMfaVerifiedAt(runtime.repos.session, sessionId);
 */
export const setMfaVerifiedAt = async (
  repo: SessionRepository,
  sessionId: string,
): Promise<void> => {
  await repo.setMfaVerifiedAt(sessionId);
};

/**
 * Returns the Unix epoch timestamp (seconds) when MFA was last verified for a session,
 * or `null` if MFA has not been completed in this session.
 *
 * @param repo - The active session repository.
 * @param sessionId - The session to query.
 * @returns Unix timestamp in seconds, or `null`.
 *
 * @example
 * const mfaAt = await getMfaVerifiedAt(runtime.repos.session, sessionId);
 * const stepUpMaxAge = runtime.config.stepUp?.maxAge ?? 300;
 * const isFresh = mfaAt && (Date.now() / 1000 - mfaAt) < stepUpMaxAge;
 */
export const getMfaVerifiedAt = async (
  repo: SessionRepository,
  sessionId: string,
): Promise<number | null> => {
  return repo.getMfaVerifiedAt(sessionId);
};

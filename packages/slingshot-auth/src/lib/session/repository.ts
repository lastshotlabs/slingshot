import type { AuthResolvedConfig } from '../../config/authConfig';
import type { RefreshResult, SessionInfo, SessionMetadata } from './types';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for auth sessions. Implemented by the memory, SQLite, Redis,
 * MongoDB, and Postgres backends — resolved at bootstrap via `sessionFactories`.
 *
 * Sessions are keyed by `sessionId` (UUID). The stored `token` is the raw JWT;
 * refresh tokens are stored hashed (SHA-256) and are never persisted in plain form.
 *
 * @remarks
 * Prefer using the top-level wrapper functions (`createSession`, `getSession`, etc.)
 * rather than calling repository methods directly. They apply the correct
 * `AuthResolvedConfig` defaults and coordinate auxiliary operations such as updating
 * `lastActiveAt` during token rotation.
 */
export interface SessionRepository {
  /**
   * Persists a new session record.
   *
   * Does **not** enforce `maxSessions` — use `atomicCreateSession` when you
   * need the concurrent-safe eviction guarantee.
   *
   * @param userId - Owner of the session.
   * @param token - Raw JWT access token to store.
   * @param sessionId - Unique session identifier (UUID).
   * @param metadata - Optional IP address and user-agent for session listing.
   * @param cfg - Resolved auth config for TTL derivation.
   *
   * @remarks
   * This method writes the session unconditionally. It does **not** check whether
   * the user already has `maxSessions` active sessions. If you call this directly
   * (bypassing the auth service) you can exceed the per-user session cap. Use
   * `atomicCreateSession` in all login paths where the cap must be enforced.
   */
  createSession(
    userId: string,
    token: string,
    sessionId: string,
    metadata?: SessionMetadata,
    cfg?: AuthResolvedConfig,
  ): Promise<void>;

  /**
   * Atomically creates a session while enforcing the `maxSessions` cap.
   *
   * If the user already has `maxSessions` active sessions the oldest one is
   * evicted before the new session is created.  The entire operation is
   * atomic within each backend (memory map lock, SQLite WAL transaction,
   * Redis Lua script, etc.).
   *
   * @param userId - Owner of the session.
   * @param token - Raw JWT access token to store.
   * @param sessionId - Unique session identifier (UUID).
   * @param maxSessions - Maximum concurrent active sessions allowed.
   * @param metadata - Optional IP address and user-agent.
   * @param cfg - Resolved auth config for TTL derivation.
   *
   * @remarks
   * **Compare-and-evict semantics**: before creating the new session the
   * implementation counts only *active* (non-expired, non-tombstoned) sessions
   * for `userId`. If the count is already at or above `maxSessions`, the session
   * with the earliest `createdAt` is evicted (respecting the tombstone setting
   * from `cfg`). The eviction loop repeats until the active count is below the
   * cap, then the new session is written. Eviction honours `persistSessionMetadata`
   * — if enabled the evicted session becomes a tombstone rather than being deleted.
   *
   * All backends implement this atomically: Redis uses a Lua script, SQLite uses a
   * WAL-mode transaction, and Postgres uses an explicit transaction. The in-memory
   * backend relies on the single-threaded Node/Bun event loop for serialisation.
   */
  atomicCreateSession(
    userId: string,
    token: string,
    sessionId: string,
    maxSessions: number,
    metadata?: SessionMetadata,
    cfg?: AuthResolvedConfig,
  ): Promise<void>;

  /**
   * Retrieves the JWT access token for an active, non-expired session.
   *
   * Returns `null` when:
   * - the session does not exist,
   * - the absolute TTL has elapsed,
   * - the idle timeout has elapsed (and the session is tombstoned or deleted).
   *
   * @param sessionId - Session identifier.
   * @param cfg - Resolved auth config for idle-timeout evaluation.
   * @returns The raw JWT string, or `null`.
   *
   * @remarks
   * A `null` return is intentionally ambiguous — callers cannot distinguish
   * between "session not found", "session expired", and "session deleted/tombstoned"
   * without querying `getUserSessions`. This is by design: a timing-distinguishable
   * difference would leak whether a session ID is valid, enabling enumeration.
   *
   * Fingerprint validation is **not** performed here. It happens in the `identify`
   * middleware after this call returns a non-null token. Raw calls to `getSession`
   * bypass fingerprint binding entirely.
   */
  getSession(sessionId: string, cfg?: AuthResolvedConfig): Promise<string | null>;

  /**
   * Revokes a session.
   *
   * When `persistSessionMetadata` is `true` in `cfg` the session record is
   * kept as a tombstone (token + refresh tokens nulled out) rather than
   * deleted, so audit queries can still see it.  Otherwise the record is
   * removed entirely.
   *
   * @param sessionId - Session to revoke.
   * @param cfg - Resolved auth config controlling tombstone behaviour.
   *
   * @remarks
   * **Tombstone behaviour** (when `cfg.persistSessionMetadata` is `true`): the
   * `token`, `refreshToken`, `prevRefreshToken`, and `prevTokenExpiresAt` fields
   * are set to `null` / `undefined`, but the session row itself is retained.
   * The row remains until the backend's natural TTL expires it (e.g., Redis key
   * expiry, SQLite `expiresAt` filter, or Mongoose TTL index). During this
   * window `getUserSessions` will include the tombstoned session when
   * `includeInactiveSessions` is `true`.
   *
   * When `persistSessionMetadata` is `false` (the default), the row is deleted
   * immediately and no record of the session remains.
   */
  deleteSession(sessionId: string, cfg?: AuthResolvedConfig): Promise<void>;

  /**
   * Returns session metadata for all sessions belonging to `userId`.
   *
   * Respects `cfg.includeInactiveSessions` and `cfg.persistSessionMetadata`
   * to determine whether tombstoned / expired sessions are included.
   *
   * @param userId - User whose sessions should be listed.
   * @param cfg - Resolved auth config.
   * @returns Array of `SessionInfo` objects (may be empty).
   *
   * @remarks
   * **Filtering rules** (applied in order):
   * 1. If `persistSessionMetadata` is `false`, only active (non-expired, non-tombstoned)
   *    sessions are ever stored — the inactive ones don't exist in the store.
   * 2. If `persistSessionMetadata` is `true` but `includeInactiveSessions` is `false`,
   *    tombstoned / expired sessions are excluded from the result even though they exist.
   * 3. Only when both `persistSessionMetadata` and `includeInactiveSessions` are `true`
   *    will the result include revoked or expired sessions.
   *
   * Tombstoned sessions are identifiable in the result by `SessionInfo.isActive === false`.
   */
  getUserSessions(userId: string, cfg?: AuthResolvedConfig): Promise<SessionInfo[]>;

  /**
   * Returns the number of currently active (non-expired, non-revoked) sessions
   * for `userId`.
   *
   * @param userId - User to count sessions for.
   * @param cfg - Resolved auth config (unused by most backends but reserved).
   * @returns Active session count (≥ 0).
   */
  getActiveSessionCount(userId: string, cfg?: AuthResolvedConfig): Promise<number>;

  /**
   * Evicts the oldest active session for `userId`.
   *
   * "Oldest" is determined by `createdAt`.  No-ops when the user has no
   * active sessions.  Called by `atomicCreateSession` overflow handling.
   *
   * @param userId - User whose oldest session should be removed.
   * @param cfg - Resolved auth config controlling tombstone behaviour.
   */
  evictOldestSession(userId: string, cfg?: AuthResolvedConfig): Promise<void>;

  /**
   * Updates the `lastActiveAt` timestamp for a session to the current time.
   *
   * Called on every authenticated request when idle-timeout is configured, to
   * reset the idle clock.
   *
   * @param sessionId - Session to touch.
   * @param cfg - Resolved auth config (reserved for future use).
   *
   * @remarks
   * Called automatically by the `identify` middleware on every authenticated request
   * when `auth.trackLastActive` or `auth.sessionPolicy.idleTimeout` is configured.
   * The call is fire-and-forget (errors are logged, not propagated) to avoid adding
   * latency to every request. The idle-timeout window measured by `isIdleExpired` is
   * always relative to the timestamp written by the most recent call to this method.
   */
  updateSessionLastActive(sessionId: string, cfg?: AuthResolvedConfig): Promise<void>;

  /**
   * Associates a refresh token with a session.
   *
   * The token is stored as a SHA-256 hash — the plain value is never
   * persisted.  Replaces any existing refresh token on the session.
   *
   * @param sessionId - Target session.
   * @param refreshToken - Plain-text refresh token to hash and store.
   * @param cfg - Resolved auth config (reserved for future use).
   *
   * @remarks
   * The plain-text refresh token is hashed with SHA-256 before storage using
   * `hashToken` from `slingshot-core`. The plaintext is only available in memory
   * at the moment of creation and is returned once to the caller; it is never
   * persisted to the store. Subsequent lookups must go through
   * `getSessionByRefreshToken`, which re-hashes the presented token and compares.
   *
   * Note: despite the name, the token is hashed (SHA-256), not encrypted or bcrypt'd.
   * SHA-256 is appropriate here because refresh tokens are high-entropy random strings
   * (32 bytes of CSPRNG output) — rainbow-table attacks are infeasible.
   */
  setRefreshToken(sessionId: string, refreshToken: string, cfg?: AuthResolvedConfig): Promise<void>;

  /**
   * Looks up a session by refresh token.
   *
   * Checks both the current token slot and the previous-token grace window.
   * Returns `null` when the token is not found, expired, or when using an
   * expired previous token (in which case the session is also revoked).
   *
   * @param refreshToken - Plain-text refresh token to look up.
   * @param cfg - Resolved auth config for idle-timeout and grace-window evaluation.
   * @returns `RefreshResult` with the session and user IDs, or `null`.
   *
   * @remarks
   * **Grace-window slot**: during token rotation (`rotateRefreshToken`) the outgoing
   * token is moved to the `prevRefreshToken` slot with a short TTL controlled by
   * `cfg.refreshTokens.rotationGraceSeconds` (default: 10 s). This method checks
   * the current slot first, then the grace-window slot, so that clients with
   * concurrent requests during a rotation period can still exchange either token.
   *
   * If the presented token matches the grace-window slot but the grace period has
   * already expired, the session is revoked (to defend against stolen token replay)
   * and `null` is returned.
   */
  getSessionByRefreshToken(
    refreshToken: string,
    cfg?: AuthResolvedConfig,
  ): Promise<RefreshResult | null>;

  /**
   * Atomically rotates a refresh token.
   *
   * Moves the current token to the "previous" slot (with a `rotationGraceSeconds`
   * window), replaces the current token with `newRefreshToken`, and updates the
   * stored access token to `newAccessToken`.
   *
   * Returns `false` — without mutating state — when `oldRefreshToken` no longer
   * matches the current slot (concurrent rotation already happened).  Pass
   * `oldRefreshToken = undefined` to skip the guard (grace-window re-rotation).
   *
   * @param sessionId - Target session.
   * @param oldRefreshToken - The token that was presented; used as a concurrency guard.
   *   Pass `undefined` to skip the guard for grace-window re-rotations.
   * @param newRefreshToken - New plain-text refresh token to store (hashed).
   * @param newAccessToken - New access JWT to replace the stored token.
   * @param cfg - Resolved auth config for `rotationGraceSeconds`.
   * @returns `true` on success, `false` when the guard fails.
   */
  rotateRefreshToken(
    sessionId: string,
    oldRefreshToken: string | undefined,
    newRefreshToken: string,
    newAccessToken: string,
    cfg?: AuthResolvedConfig,
  ): Promise<boolean>;

  /**
   * Retrieves the stored session-binding fingerprint.
   *
   * Returns `null` when no fingerprint has been set (session was created
   * before the binding config was enabled, or `setSessionFingerprint` has not
   * yet been called).
   *
   * @param sessionId - Target session.
   * @returns The stored fingerprint string, or `null`.
   */
  getSessionFingerprint(sessionId: string): Promise<string | null>;

  /**
   * Persists a session-binding fingerprint for `sessionId`.
   *
   * The fingerprint is a hash of stable request attributes (IP, UA, etc.)
   * computed at session creation time.  Subsequent requests are validated
   * against it when session binding is enabled.
   *
   * @param sessionId - Target session.
   * @param fingerprint - Fingerprint string to store.
   */
  setSessionFingerprint(sessionId: string, fingerprint: string): Promise<void>;

  /**
   * Records the Unix timestamp (seconds) at which MFA was verified for this session.
   *
   * Set immediately after a successful MFA challenge during login or step-up.
   * The timestamp is used by routes that require recent MFA to enforce
   * re-verification after a configurable window.
   *
   * @param sessionId - Target session.
   */
  setMfaVerifiedAt(sessionId: string): Promise<void>;

  /**
   * Retrieves the Unix timestamp (seconds) at which MFA was last verified.
   *
   * @param sessionId - Target session.
   * @returns Unix seconds timestamp, or `null` when MFA has not been verified
   *   in this session.
   */
  getMfaVerifiedAt(sessionId: string): Promise<number | null>;
}

import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Returns the configured absolute session TTL in seconds.
 *
 * Falls back to `DEFAULT_SESSION_TTL_SECONDS` (7 days) when
 * `sessionPolicy.absoluteTimeout` is not set in `cfg`.
 *
 * @param cfg - Resolved auth config.  Uses `DEFAULT_AUTH_CONFIG` when absent.
 * @returns TTL in seconds.
 *
 * @remarks
 * The default TTL is **7 days** (604800 seconds). Override via
 * `auth.sessionPolicy.absoluteTimeout` in the plugin config.
 */
export function getSessionTtlSeconds(cfg?: AuthResolvedConfig): number {
  return (cfg ?? DEFAULT_AUTH_CONFIG).sessionPolicy.absoluteTimeout ?? DEFAULT_SESSION_TTL_SECONDS;
}

/**
 * Returns the configured absolute session TTL in milliseconds.
 *
 * Convenience wrapper around `getSessionTtlSeconds` for timestamp arithmetic.
 *
 * @param cfg - Resolved auth config.
 * @returns TTL in milliseconds.
 */
export function getSessionTtlMs(cfg?: AuthResolvedConfig): number {
  return getSessionTtlSeconds(cfg) * 1000;
}

/**
 * Returns whether completed (revoked) sessions should be kept as tombstone
 * records rather than immediately deleted.
 *
 * When `true`, `deleteSession` nulls out the token and refresh tokens but
 * preserves the row so `getUserSessions` can still include the session in
 * audit listings.
 *
 * @param cfg - Resolved auth config.
 * @returns `true` when tombstone persistence is enabled.
 *
 * @remarks
 * **Tombstone semantics**: when this returns `true`, calling `deleteSession`
 * does not remove the database row. Instead it nulls the `token`,
 * `refreshToken`, and `prevRefreshToken` columns while leaving `sessionId`,
 * `userId`, `createdAt`, and `ipAddress`/`userAgent` intact for audit queries.
 * The row is eventually cleaned up by the TTL expiry of the backend store (Redis
 * key expiry, SQLite/Postgres row with expired `expiresAt`, or Mongoose TTL
 * index). `getUserSessions` will include tombstoned sessions in its results only
 * when `config.includeInactiveSessions` is also `true`.
 */
export function shouldPersistSessionMetadata(cfg?: AuthResolvedConfig): boolean {
  return (cfg ?? DEFAULT_AUTH_CONFIG).persistSessionMetadata;
}

/**
 * Returns whether a session has exceeded the configured idle timeout.
 *
 * Idle timeout is measured from `lastActiveAt`.  When `sessionPolicy.idleTimeout`
 * is not set the function always returns `false` (no idle expiry).
 *
 * @param lastActiveAt - Unix timestamp (ms) of the session's last activity.
 * @param cfg - Resolved auth config.
 * @returns `true` when the session has been idle longer than `idleTimeout`.
 *
 * @remarks
 * Idle timeout is measured from the timestamp written by the most recent call to
 * `updateSessionLastActive` for the session. `updateSessionLastActive` is invoked
 * automatically by the `identify` middleware on every authenticated request when
 * `auth.trackLastActive` or `auth.sessionPolicy.idleTimeout` is configured. If the
 * identify middleware is not running (e.g., a raw repo call in a background job),
 * `lastActiveAt` will not advance and the session will appear idle sooner than
 * expected.
 */
export function isIdleExpired(lastActiveAt: number, cfg?: AuthResolvedConfig): boolean {
  const idleTimeout = (cfg ?? DEFAULT_AUTH_CONFIG).sessionPolicy.idleTimeout;
  if (!idleTimeout) return false;
  const idleSecs = (Date.now() - lastActiveAt) / 1000;
  return idleSecs > idleTimeout;
}

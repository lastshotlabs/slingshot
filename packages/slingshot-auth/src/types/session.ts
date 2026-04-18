/**
 * Optional metadata captured at session creation time for auditing and display.
 *
 * Stored alongside the session token and surfaced via `GET /auth/sessions`.
 * Neither field is required — omitting them is valid for non-browser clients.
 */
export interface SessionMetadata {
  /** Client IP address at session creation (after proxy header resolution). */
  ipAddress?: string;
  /** `User-Agent` header value at session creation. */
  userAgent?: string;
}

/**
 * Public representation of an active (or recently expired) session.
 *
 * Returned by session listing endpoints so users can review and revoke their
 * own sessions. All timestamps are Unix epoch milliseconds.
 */
export interface SessionInfo {
  /** Unique session identifier (UUID or similar opaque string). */
  sessionId: string;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /**
   * Unix timestamp (ms) of the most recent authenticated request.
   * Updated on each request when `auth.trackLastActive` or
   * `auth.sessionPolicy.idleTimeout` is configured. May be `0` or stale
   * when last-active tracking is disabled.
   */
  lastActiveAt: number;
  /** Unix timestamp (ms) when the session expires (absolute TTL). */
  expiresAt: number;
  /** IP address recorded at session creation. */
  ipAddress?: string;
  /** User-agent string recorded at session creation. */
  userAgent?: string;
  /** Whether the session is currently valid — not expired and not revoked. */
  isActive: boolean;
}

/**
 * Result of a successful refresh-token exchange.
 *
 * The old refresh token is consumed; the caller must issue a fresh token when the
 * exchange succeeds. When the presented token was found in the grace window
 * (`fromGrace: true`), it means the previous rotation was not persisted by the
 * client (for example after a network failure) and a grace-window replay was
 * accepted.
 */
export interface RefreshResult {
  /** The session ID whose TTL was extended by this refresh. */
  sessionId: string;
  /** The user ID associated with the refreshed session. */
  userId: string;
  /** `true` when the token was found in the grace-window (`prevRefreshToken`) slot rather
   * than the current slot — indicates a client retry after a failed rotation. */
  fromGrace: boolean;
}

/**
 * Payload stored (and later retrieved) when an OAuth authorization code is issued.
 *
 * The authorization code is short-lived (60 seconds) and single-use. It bridges the
 * OAuth redirect callback and the token exchange step (`GET /auth/callback` → client
 * redirect → `POST /auth/token`). Only the SHA-256 hash of the code is persisted;
 * sensitive fields (`token`, `refreshToken`) may be encrypted at rest when data
 * encryption keys are configured.
 */
export interface OAuthCodePayload {
  /** The JWT session token to deliver to the client after a successful code exchange. */
  token: string;
  /** The ID of the authenticated user. */
  userId: string;
  /** The user's email address (present when `primaryField` is `'email'`). */
  email?: string;
  /** Refresh token to deliver alongside the session token (present when refresh tokens are enabled). */
  refreshToken?: string;
}

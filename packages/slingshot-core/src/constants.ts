/**
 * Cookie name for the session access token (HttpOnly, short-lived).
 * Used by the auth plugin to set and read the primary session credential.
 */
export const COOKIE_TOKEN = 'token';

/**
 * HTTP header name for the session access token (alternative to cookie transport).
 * Used by SPA and mobile clients that manage tokens in memory.
 */
export const HEADER_USER_TOKEN = 'x-user-token';

/**
 * Cookie name for the long-lived refresh token (HttpOnly, secure).
 * Used by the auth plugin to issue new access tokens without re-authentication.
 */
export const COOKIE_REFRESH_TOKEN = 'refresh_token';

/**
 * HTTP header name for the refresh token (alternative to cookie transport).
 */
export const HEADER_REFRESH_TOKEN = 'x-refresh-token';

/**
 * Cookie name for the CSRF synchronizer token.
 * Set as a readable (non-HttpOnly) cookie so that JavaScript can copy it into the header.
 */
export const COOKIE_CSRF_TOKEN = 'csrf_token';

/**
 * HTTP request header name for the CSRF token submitted by the client.
 * The CSRF middleware compares this value against `COOKIE_CSRF_TOKEN`.
 */
export const HEADER_CSRF_TOKEN = 'x-csrf-token';

/**
 * HTTP header name for the per-request trace identifier.
 * Set by the request-id middleware and echoed in all error responses.
 */
export const HEADER_REQUEST_ID = 'x-request-id';

/**
 * HTTP header name for the client-provided idempotency key.
 * Used by the idempotency middleware to deduplicate mutating requests.
 */
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';

/**
 * HTTP header name for the HMAC request signature.
 * Used by the webhook signing middleware to verify inbound webhook authenticity.
 */
export const HEADER_SIGNATURE = 'x-signature';

/**
 * HTTP header name for the request timestamp included in the HMAC signature.
 * The signing middleware rejects requests with a timestamp outside the replay window.
 */
export const HEADER_TIMESTAMP = 'x-timestamp';

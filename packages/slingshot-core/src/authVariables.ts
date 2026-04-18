// Auth-specific Hono context variables.
// Set by identity middleware (identify, bearerAuth) on each request.
// Merged into AppEnv in context.ts.

/**
 * Auth-specific Hono context variables set by identity middleware on each request.
 *
 * These variables are merged into `AppEnv.Variables` via `AppEnv = { Variables: AppVariables & AuthVariables }`.
 * Access them via `c.get('authUserId')`, `c.get('roles')`, etc. in route handlers.
 *
 * @remarks
 * All fields are `null` on unauthenticated requests. Auth middleware (`identify`, `bearerAuth`)
 * populates them before route handlers run. Session-bound routes should always check
 * that `authUserId` is non-null before proceeding.
 */
export interface AuthVariables {
  /**
   * Authenticated user ID from the JWT `sub` claim.
   *
   * @remarks
   * Set by the `identify` middleware after a valid session or bearer JWT is verified.
   * `null` on unauthenticated requests and on M2M token requests (which use
   * `authClientId` instead). Use this as the canonical "who is acting" identifier in
   * route handlers — prefer it over extracting `sub` from `tokenPayload` manually.
   */
  authUserId: string | null;
  /**
   * Session ID from the JWT `sid` claim.
   *
   * @remarks
   * Set by `identify` for session-bound JWTs (interactive user logins). `null` when
   * unauthenticated, when using short-lived M2M tokens (which carry no `sid`), or when
   * using static bearer tokens from `BearerAuthClient` entries. Use this to correlate
   * audit log entries or to revoke a specific session.
   */
  sessionId: string | null;
  /**
   * Effective roles for the authenticated user.
   *
   * @remarks
   * Set by `identify` from the JWT `roles` claim, or resolved from the DB when the auth
   * plugin is configured to hydrate roles from the session store. `null` when
   * unauthenticated. An empty array (`[]`) means the user is authenticated but has no
   * roles assigned — this is distinct from `null` (unauthenticated). Use role membership
   * checks (e.g. `roles.includes('admin')`) rather than checking for non-null.
   */
  roles: string[] | null;
  /**
   * M2M client ID from a scope-bearing machine-to-machine JWT (no `sid` claim).
   *
   * @remarks
   * Set by `identify` when the verified JWT contains an `azp` or `client_id` claim and
   * no `sid` claim, indicating a service-account token rather than an interactive session.
   * `null` on all other request types (unauthenticated, user session, bearer). When set,
   * `authUserId` and `sessionId` will both be `null`.
   */
  authClientId: string | null;
  /**
   * Bearer client ID from a matched `BearerAuthClient` configuration entry.
   *
   * @remarks
   * Set by the `bearerAuth` middleware when the `Authorization: Bearer <token>` header
   * matches a statically configured `BearerAuthClient` (API key / shared secret).
   * `null` when not using static bearer token auth or when the token does not match any
   * configured client. This is distinct from `authClientId` — bearer auth uses pre-shared
   * keys, while M2M auth uses signed JWTs.
   */
  bearerClientId: string | null;
  /**
   * The raw, already-verified JWT payload stashed by the identity middleware.
   *
   * @remarks
   * Set by `identify` after the token signature is verified. Contains all claims from the
   * JWT (e.g. `sub`, `sid`, `roles`, `azp`, `exp`, custom claims). Typed `unknown` to
   * avoid a hard dependency on the auth plugin's JWT payload type in `slingshot-core` —
   * cast to `AuthTokenPayload` (from `slingshot-auth`) at use sites that need typed access.
   * `null` when unauthenticated or when only `bearerAuth` (not `identify`) ran.
   */
  tokenPayload: unknown;
}

/**
 * The authenticated principal injected into the Hono context by the community
 * plugin's authentication middleware.
 *
 * Stored under the `communityPrincipal` context variable and accessed via
 * `c.get('communityPrincipal')` inside community route handlers and middleware.
 *
 * @property subject - The stable user identifier (e.g. a UUID or external auth
 *   provider subject claim).
 * @property roles - An array of role strings assigned to the principal in the
 *   current request context (e.g. `['admin']`, `['moderator']`).
 */
export type CommunityPrincipal = { subject: string; roles: string[] };

/**
 * Hono environment type for community plugin routes.
 *
 * Pass this as the `Env` type parameter when creating community-scoped Hono
 * apps or when calling `c.get('communityPrincipal')` in typed middleware.
 *
 * @example
 * ```ts
 * const app = new Hono<CommunityEnv>();
 * app.use('*', communityPlugin.setupMiddleware(app));
 * ```
 */
export type CommunityEnv = {
  Variables: { communityPrincipal: CommunityPrincipal | undefined };
};

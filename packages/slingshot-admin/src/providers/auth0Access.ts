import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AdminAccessProvider, AdminPrincipal } from '@lastshotlabs/slingshot-core';
import { type Logger, createConsoleLogger } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for the Auth0-backed `AdminAccessProvider`.
 *
 * @example
 * ```ts
 * const config: Auth0AccessProviderConfig = {
 *   domain: 'my-tenant.auth0.com',
 *   audience: 'https://api.myapp.com',
 * };
 * ```
 */
export interface Auth0AccessProviderConfig {
  /** Auth0 tenant domain, e.g. `"my-tenant.auth0.com"`. Used to build the JWKS URL. */
  domain: string;
  /** Expected `aud` claim in the JWT. Must match the API identifier configured in Auth0. */
  audience: string;
  /** Maximum milliseconds for JWT verification (JWKS fetch + signature check). Default: 5000. */
  verifyTimeoutMs?: number;
  /**
   * Structured logger used to surface claim-validation failures. When omitted,
   * a console-backed logger is used so the failures are at least observable.
   * Provide your application logger to route them through your aggregation
   * pipeline.
   */
  logger?: Logger;
}

/**
 * Zod schema enforcing the shape of the claims this package consumes from an
 * Auth0 JWT.
 *
 * P-ADMIN-7: prior to this validation we passed the raw `payload` to
 * downstream consumers via `rawClaims`. A token whose `email` was an array or
 * `name` was a number would silently produce a malformed `AdminPrincipal`.
 * The schema rejects those tokens (returning `null` from `verifyRequest`) and
 * a structured warning so operators see the failure mode.
 */
const Auth0JwtClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Dependency injection surface for `createAuth0AccessProvider`.
 *
 * Provides overridable handles for `jose`'s `createRemoteJWKSet` and
 * `jwtVerify` so that unit tests can stub network calls without needing a
 * real Auth0 tenant.
 *
 * @remarks
 * This interface is not part of the public package entry point. It is
 * exported only to allow type-safe test overrides via the optional `deps`
 * parameter of `createAuth0AccessProvider`.
 *
 * In production code always use the default (`{ createRemoteJWKSet, jwtVerify }`
 * from `jose`). In tests, supply a stub that returns a pre-built JWKS and
 * resolves `jwtVerify` immediately without a network round-trip:
 *
 * @example
 * ```ts
 * import { createAuth0AccessProvider } from '@lastshotlabs/slingshot-admin';
 * import type { Auth0Deps } from '@lastshotlabs/slingshot-admin';
 *
 * // In tests only: jose's JWKS function is opaque, so a no-op stub is acceptable.
 * const stubDeps: Auth0Deps = {
 *   createRemoteJWKSet: () =>
 *     (() => Promise.resolve({} as never)) as ReturnType<typeof createRemoteJWKSet>,
 *   jwtVerify: async (_token, _keys, _opts) => ({
 *     payload: { sub: 'test-user', aud: 'https://api.example.com' },
 *     protectedHeader: { alg: 'RS256' },
 *   }),
 * };
 *
 * const provider = createAuth0AccessProvider(
 *   { domain: 'test.auth0.com', audience: 'https://api.example.com' },
 *   stubDeps,
 * );
 * ```
 */
export interface Auth0Deps {
  createRemoteJWKSet: typeof createRemoteJWKSet;
  jwtVerify: typeof jwtVerify;
}

/**
 * Creates an `AdminAccessProvider` that verifies RS256 JWTs issued by Auth0.
 *
 * @remarks
 * **JWKS caching:** `jose`'s `createRemoteJWKSet()` returns a function that
 * lazily fetches the JWKS from `https://<domain>/.well-known/jwks.json` on the
 * first `jwtVerify` call. Subsequent calls reuse the in-memory keyset until
 * the JWT references an unknown `kid`, at which point `jose` automatically
 * re-fetches the JWKS to pick up any key rotation. The JWKS function (`JWKS`)
 * is created once at provider construction time and shared across all requests.
 *
 * **Token caching:** Individual JWT verification results are **not** cached.
 * Every request re-verifies the token's signature, expiry (`exp`), `aud`
 * claim, and `iss` (issuer, expected to be `https://<domain>/`). This is intentional — admin tokens should be short-lived (< 1 hour)
 * and individual token revocation is not supported by the JWKS approach.
 *
 * **Error handling:** Any verification failure (expired token, wrong audience,
 * bad signature, network error, missing `sub` claim) causes `verifyRequest` to
 * return `null`. The admin middleware translates `null` into a 401 response.
 * No error details are surfaced to the caller to avoid leaking validation state.
 *
 * @param config - Auth0 tenant domain and API audience.
 * @param deps - Optional jose dependency overrides; useful for unit testing
 *   without real network calls. Defaults to the real `jose` implementations.
 * @returns A ready-to-use `AdminAccessProvider` with `name: 'auth0'`.
 *
 * @example
 * ```ts
 * import { createAdminPlugin, createAuth0AccessProvider } from '@lastshotlabs/slingshot-admin';
 *
 * const adminPlugin = createAdminPlugin({
 *   accessProvider: createAuth0AccessProvider({
 *     domain: 'acme.auth0.com',
 *     audience: 'https://api.acme.com',
 *   }),
 *   // ...
 * });
 * ```
 */
export function createAuth0AccessProvider(
  config: Auth0AccessProviderConfig,
  deps: Auth0Deps = { createRemoteJWKSet, jwtVerify },
): AdminAccessProvider {
  const jwksUrl = new URL(`https://${config.domain}/.well-known/jwks.json`);
  const JWKS = deps.createRemoteJWKSet(jwksUrl);
  const logger: Logger = config.logger ?? createConsoleLogger({ level: 'warn' });

  return {
    name: 'auth0',

    async verifyRequest(c): Promise<AdminPrincipal | null> {
      try {
        const authHeader = c.req.header('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.slice(7);

        const timeoutMs = config.verifyTimeoutMs ?? 5_000;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        const { payload } = await Promise.race([
          deps.jwtVerify(token, JWKS, {
            audience: config.audience,
            issuer: `https://${config.domain}/`,
            // Restrict to RS256 (Auth0's standard signing algorithm). This rejects
            // `alg: none` AND any algorithm-substitution attempt where an attacker
            // tries to coerce verification into a weaker symmetric algorithm.
            algorithms: ['RS256'],
          }),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(
              () => reject(new Error('JWT verification timed out')),
              timeoutMs,
            );
          }),
        ]).finally(() => {
          // Always clear the timeout timer so it does not linger after the
          // race resolves, preventing a timer leak under high QPS.
          clearTimeout(timerId);
        });

        // P-ADMIN-7: validate the claim shape before we propagate it to
        // downstream consumers. Returning a partial principal — e.g. one whose
        // `email` is an array — is worse than returning null and forcing a
        // 401, because the caller has no way to know the principal is broken.
        const parsed = Auth0JwtClaimsSchema.safeParse(payload);
        if (!parsed.success) {
          logger.warn('[slingshot-admin] auth0 jwt claim shape rejected', {
            event: 'auth0_claim_validation_failed',
            issues: parsed.error.issues.map(i => ({
              path: i.path.join('.'),
              code: i.code,
              message: i.message,
            })),
          });
          return null;
        }
        const claims = parsed.data;

        return {
          subject: claims.sub,
          provider: 'auth0',
          email: claims.email,
          displayName: claims.name,
          rawClaims: payload as Record<string, unknown>,
        };
      } catch {
        return null;
      }
    },
  };
}

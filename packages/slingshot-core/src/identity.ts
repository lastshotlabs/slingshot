/**
 * Actor-based identity abstraction.
 *
 * Decouples all framework consumers (guards, permissions, data scoping, audit,
 * entity routes) from specific auth-provider field names by mapping them into
 * the canonical `Actor` shape.
 *
 * Custom auth integrations implement `IdentityResolver` to map their own
 * identity representation into the canonical `Actor` shape.
 */

/**
 * Discriminator for the kind of actor making a request.
 *
 * - `'user'`            — an interactive human user session.
 * - `'service-account'` — a machine-to-machine client (e.g. M2M JWT with `azp`/`client_id`).
 * - `'api-key'`         — a statically configured bearer/API-key client.
 * - `'system'`          — an internal framework-initiated action (cron, lifecycle).
 * - `'anonymous'`       — unauthenticated request.
 */
export type ActorKind = 'user' | 'service-account' | 'api-key' | 'system' | 'anonymous';

/**
 * Canonical identity for the current request.
 *
 * All framework consumers (guards, permissions, data scoping, audit, entity
 * routes) read identity through this shape rather than reaching into raw Hono
 * context variables or `HandlerMeta` legacy fields.
 */
export interface Actor {
  /** Primary identifier for the actor. `null` when anonymous/unauthenticated. */
  readonly id: string | null;
  /** Discriminator for the kind of actor. */
  readonly kind: ActorKind;
  /** Tenant scope, or `null` for single-tenant / tenantless actors. */
  readonly tenantId: string | null;
  /** Session ID when the actor is session-bound. `null` otherwise. */
  readonly sessionId: string | null;
  /** Effective roles for this actor. `null` when unauthenticated. */
  readonly roles: string[] | null;
  /**
   * Extension bag for custom claims from the identity provider.
   *
   * Custom auth integrations place provider-specific fields here (e.g.
   * `{ orgId: 'org_123', department: 'engineering' }`) rather than requiring
   * framework-level type changes. Entity data-scope bindings can reference
   * claims via `ctx:actor.claims.<key>`.
   */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Frozen anonymous actor singleton. */
export const ANONYMOUS_ACTOR: Actor = Object.freeze({
  id: null,
  kind: 'anonymous' as const,
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: Object.freeze({}),
});

/**
 * Raw identity variables available to the resolver.
 *
 * These are the values set by whatever auth middleware ran before the resolver
 * executes (identify, bearerAuth, gateway auth, custom middleware, etc.).
 */
export interface IdentityResolverInput {
  authUserId: string | null;
  sessionId: string | null;
  roles: string[] | null;
  authClientId: string | null;
  bearerClientId: string | null;
  tenantId: string | null;
  /** The raw, already-verified token payload (JWT claims, gateway context, etc.). */
  tokenPayload: unknown;
}

/**
 * Maps raw auth context into a canonical `Actor`.
 *
 * Configured on the app via `CoreRegistrar.setIdentityResolver()` or the
 * `identity.resolver` option in `createApp()` / `createServer()`. When no
 * custom resolver is registered the framework uses the default resolver which
 * preserves existing behavior exactly.
 */
export interface IdentityResolver {
  resolve(input: IdentityResolverInput): Actor;
}

/**
 * Default resolver that preserves the framework's existing identity behavior.
 *
 * - If `authUserId` is set, the actor is a `'user'`.
 * - If only `bearerClientId` is set, the actor is an `'api-key'`.
 * - If only `authClientId` is set, the actor is a `'service-account'`.
 * - Otherwise, the actor is `'anonymous'` (with tenantId carried through).
 */
export function createDefaultIdentityResolver(): IdentityResolver {
  return {
    resolve(input: IdentityResolverInput): Actor {
      if (input.authUserId) {
        return {
          id: input.authUserId,
          kind: 'user',
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          roles: input.roles,
          claims: {},
        };
      }
      if (input.bearerClientId) {
        return {
          id: input.bearerClientId,
          kind: 'api-key',
          tenantId: input.tenantId,
          sessionId: null,
          roles: input.roles,
          claims: {},
        };
      }
      if (input.authClientId) {
        return {
          id: input.authClientId,
          kind: 'service-account',
          tenantId: input.tenantId,
          sessionId: null,
          roles: input.roles,
          claims: {},
        };
      }
      return {
        ...ANONYMOUS_ACTOR,
        tenantId: input.tenantId,
      };
    },
  };
}

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
 * Identity values extracted from the request, passed to the configured
 * `IdentityResolver` to produce a canonical `Actor`.
 *
 * Field names map to the actor kind they produce in the default resolver:
 * - `userId`            → `'user'` actor
 * - `serviceAccountId`  → `'service-account'` actor (M2M / OAuth client)
 * - `apiKeyId`          → `'api-key'` actor (static bearer-token client)
 *
 * Custom auth integrations populate whichever of these fields they recognize
 * before invoking the resolver.
 */
export interface IdentityResolverInput {
  /** Authenticated user ID (subject of an interactive session). */
  userId: string | null;
  /** Session identifier when the user is session-bound. */
  sessionId: string | null;
  /** Effective roles assigned to the principal. */
  roles: string[] | null;
  /** Service-account / M2M client ID (e.g. JWT `azp` / `client_id`). */
  serviceAccountId: string | null;
  /** Static API-key client ID (e.g. matched bearer-token client). */
  apiKeyId: string | null;
  /** Tenant scope captured at extraction time. */
  tenantId: string | null;
  /** The raw, already-verified token payload (JWT claims, gateway context, etc.). */
  tokenPayload: unknown;
}

/**
 * Maps raw identity input into a canonical `Actor`.
 *
 * Configured on the app via `CoreRegistrar.setIdentityResolver()` or the
 * `identity.resolver` option in `createApp()` / `createServer()`. When no
 * custom resolver is registered the framework uses the default resolver.
 */
export interface IdentityResolver {
  resolve(input: IdentityResolverInput): Actor;
}

/**
 * Default resolver. Selection order:
 *
 * - If `userId` is set, the actor is a `'user'`.
 * - If only `apiKeyId` is set, the actor is an `'api-key'`.
 * - If only `serviceAccountId` is set, the actor is a `'service-account'`.
 * - Otherwise, the actor is `'anonymous'` (with `tenantId` carried through).
 */
export function createDefaultIdentityResolver(): IdentityResolver {
  return {
    resolve(input: IdentityResolverInput): Actor {
      if (input.userId) {
        return {
          id: input.userId,
          kind: 'user',
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          roles: input.roles,
          claims: {},
        };
      }
      if (input.apiKeyId) {
        return {
          id: input.apiKeyId,
          kind: 'api-key',
          tenantId: input.tenantId,
          sessionId: null,
          roles: input.roles,
          claims: {},
        };
      }
      if (input.serviceAccountId) {
        return {
          id: input.serviceAccountId,
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

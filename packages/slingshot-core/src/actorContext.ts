import type { Context } from 'hono';
import type { AppEnv } from './context';
import { deepFreeze } from './deepFreeze';
import {
  ANONYMOUS_ACTOR,
  createDefaultIdentityResolver,
  type Actor,
  type IdentityResolverInput,
} from './identity';

const DEFAULT_IDENTITY_RESOLVER = createDefaultIdentityResolver();

function publishActor(c: Context<AppEnv>, actor: Actor): void {
  const contextSet = (c as { set?: (key: 'actor', value: Actor) => void }).set;
  if (typeof contextSet === 'function') {
    contextSet.call(c, 'actor', actor);
  }
}

function readNullableString(
  c: Context<AppEnv>,
  key: 'authUserId' | 'sessionId' | 'authClientId' | 'bearerClientId' | 'tenantId',
): string | null {
  const value = c.get(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRoles(c: Context<AppEnv>): string[] | null {
  const value = c.get('roles');
  return Array.isArray(value) ? value.filter(role => typeof role === 'string') : null;
}

function readResolverInput(c: Context<AppEnv>): IdentityResolverInput {
  return {
    authUserId: readNullableString(c, 'authUserId'),
    sessionId: readNullableString(c, 'sessionId'),
    roles: readRoles(c),
    authClientId: readNullableString(c, 'authClientId'),
    bearerClientId: readNullableString(c, 'bearerClientId'),
    tenantId: readNullableString(c, 'tenantId'),
    tokenPayload: c.get('tokenPayload') ?? null,
  };
}

function hasConcreteIdentity(input: IdentityResolverInput): boolean {
  return Boolean(input.authUserId ?? input.authClientId ?? input.bearerClientId);
}

function isActorFrozen(actor: Actor): boolean {
  return (
    Object.isFrozen(actor) &&
    Object.isFrozen(actor.claims) &&
    (actor.roles === null || Object.isFrozen(actor.roles))
  );
}

function freezeActor(actor: Actor): Actor {
  if (actor === ANONYMOUS_ACTOR || isActorFrozen(actor)) {
    return actor;
  }

  const normalized: Actor = {
    ...actor,
    roles: actor.roles ? [...actor.roles] : null,
    claims: deepFreeze({ ...actor.claims }),
  };
  if (normalized.roles) {
    Object.freeze(normalized.roles);
  }
  return Object.freeze(normalized);
}

function shouldRefreshActor(actor: Actor | null, input: IdentityResolverInput): boolean {
  if (!actor) return true;
  if (actor.kind === 'anonymous' && hasConcreteIdentity(input)) return true;
  return false;
}

/**
 * Resolve the canonical actor for a Hono request context.
 *
 * Prefers `c.get('actor')` when already present. When actor context has not been
 * published yet, falls back to the app's configured `IdentityResolver`, using the
 * legacy auth variables as upstream inputs. If no context-bound resolver is
 * available, the built-in default resolver is used.
 */
export function getActor(c: Context<AppEnv>): Actor {
  const existing = c.get('actor');
  const input = readResolverInput(c);

  if (!shouldRefreshActor(existing, input)) {
    const actor = existing ? freezeActor(existing) : ANONYMOUS_ACTOR;
    if (actor !== existing) {
      publishActor(c, actor);
    }
    return actor;
  }

  const resolver = c.get('slingshotCtx')?.identityResolver ?? DEFAULT_IDENTITY_RESOLVER;
  const actor = freezeActor(resolver.resolve(input));
  publishActor(c, actor);
  return actor;
}

/**
 * Resolve the current actor ID from request context.
 *
 * Returns `null` for anonymous requests.
 */
export function getActorId(c: Context<AppEnv>): string | null {
  return getActor(c).id;
}

/**
 * Resolve the current actor tenant scope from request context.
 *
 * Returns `null` for tenantless actors and single-tenant requests.
 */
export function getActorTenantId(c: Context<AppEnv>): string | null {
  return getActor(c).tenantId;
}

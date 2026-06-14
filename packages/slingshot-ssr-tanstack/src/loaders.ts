// SSR loader helpers — collapse the actor + policy + adapter boilerplate
// that every `.server.ts` companion would otherwise repeat.
//
// Why these exist: a typical SSR loader needs to (a) resolve the requesting
// user into an `Actor`, (b) build a context carrying the slingshot
// permissions evaluator, and (c) call a `canX(actor, resource, policyCtx)`
// check before serving sensitive data. Without helpers, each loader copies
// ~30 lines of glue. With them, a typical authed loader is 3 lines:
//
//   const guard = await requirePolicy(ctx, canReadThread, threadId);
//   if ('forbidden' in guard) return guard;
//   const { actor, policyCtx } = guard;
//
// All helpers take the slingshot `SsrLoadContext` so they're directly
// callable from inside any `.server.ts` `load()` function. The envelope
// keys (`unauthorized`, `forbidden`) are mapped to HTTP statuses (401, 403)
// by slingshot-ssr's middleware automatically.
import { type Actor, resolveCapabilityValue } from '@lastshotlabs/slingshot-core';
import {
  type PermissionEvaluator,
  PermissionsEvaluatorCap,
} from '@lastshotlabs/slingshot-permissions';
import type { SsrLoadContext } from '@lastshotlabs/slingshot-ssr';

/**
 * Policy context — what every `canX()` function needs at hand. `carrier` is
 * anything the slingshot pluginState helpers accept (typically `bsCtx`);
 * `permissions` is the resolved evaluator.
 */
export interface PolicyCtx {
  readonly carrier: object;
  readonly permissions: PermissionEvaluator;
}

export type { Actor };

/**
 * Build an `Actor` from the request's authenticated user (or anonymous when
 * unauthenticated). Mirrors the actor shape every `canX` policy expects.
 *
 * Performs `await ctx.getUser()` exactly once; cache the result if you need
 * it more than once in a single load.
 */
export async function loadActor(ctx: SsrLoadContext): Promise<Actor> {
  const user = await ctx.getUser();
  if (user) {
    return {
      id: user.id,
      kind: 'user',
      tenantId: null,
      sessionId: null,
      roles: user.roles,
      claims: {},
    };
  }
  return {
    id: null,
    kind: 'anonymous',
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: {},
  };
}

/**
 * Resolve the {@link PolicyCtx} required by every `canX` policy function:
 * the slingshot context (carrier) and the permissions evaluator.
 *
 * Throws when slingshot-permissions is not registered — that's a deployment
 * misconfiguration, not a per-request error, so we surface it loudly.
 */
export function getPolicyCtx(ctx: SsrLoadContext): PolicyCtx {
  const permissions = resolveCapabilityValue(ctx.bsCtx as never, PermissionsEvaluatorCap);
  if (!permissions) {
    throw new Error(
      'PermissionsEvaluatorCap unavailable — register slingshot-permissions in your app config.',
    );
  }
  return { carrier: ctx.bsCtx as object, permissions };
}

/**
 * Combined actor + policyCtx fetch. Use when you need both — most authed
 * loaders do.
 */
export async function requireActor(ctx: SsrLoadContext): Promise<{
  readonly actor: Actor;
  readonly policyCtx: PolicyCtx;
}> {
  const [actor, policyCtx] = [await loadActor(ctx), getPolicyCtx(ctx)];
  return { actor, policyCtx };
}

/**
 * Gate a loader on a logged-in user. Returns either the unauthorized signal
 * (the loader should `return` it directly — slingshot-ssr middleware maps
 * it to HTTP 401) or the actor + policyCtx for the loader to use.
 *
 * @example
 * ```ts
 * export async function load(ctx: SsrLoadContext) {
 *   const auth = await requireUser(ctx);
 *   if ('unauthorized' in auth) return auth;
 *   // … use auth.actor, auth.policyCtx …
 * }
 * ```
 */
export async function requireUser(
  ctx: SsrLoadContext,
): Promise<
  { readonly unauthorized: true } | { readonly actor: Actor; readonly policyCtx: PolicyCtx }
> {
  const { actor, policyCtx } = await requireActor(ctx);
  if (actor.kind === 'anonymous') return { unauthorized: true } as const;
  return { actor, policyCtx };
}

/**
 * Gate a loader on a `canX(actor, resource, policyCtx)` check. Returns
 * either the forbidden signal (the loader should `return` it directly —
 * slingshot-ssr middleware maps it to HTTP 403) or the actor + policyCtx
 * for use in the rest of the loader.
 *
 * The check is a function reference, not a name — pass `canReadThread`,
 * `canModerateContainer`, etc. The resource is whatever the check needs
 * (typically an id or slug).
 *
 * @example
 * ```ts
 * import { canReadThread } from './my-policy-module';
 * import { requirePolicy } from '@lastshotlabs/slingshot-ssr-tanstack';
 *
 * export async function load(ctx) {
 *   const guard = await requirePolicy(ctx, canReadThread, threadId);
 *   if ('forbidden' in guard) return guard;
 *   const { actor, policyCtx } = guard;
 *   // … fetch the thread, return data …
 * }
 * ```
 */
export async function requirePolicy<TResource>(
  ctx: SsrLoadContext,
  check: (actor: Actor, resource: TResource, policyCtx: PolicyCtx) => Promise<boolean>,
  resource: TResource,
): Promise<
  { readonly forbidden: true } | { readonly actor: Actor; readonly policyCtx: PolicyCtx }
> {
  const { actor, policyCtx } = await requireActor(ctx);
  const allowed = await check(actor, resource, policyCtx);
  if (!allowed) return { forbidden: true } as const;
  return { actor, policyCtx };
}

import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { RequestActorResolver } from './coreContracts';

export type { RequestActorResolver };

// ---------------------------------------------------------------------------
// RequestActorResolver -- resolves an actor identity from a raw HTTP request.
// ---------------------------------------------------------------------------

/**
 * Retrieve the `RequestActorResolver` registered on a Slingshot app or context instance.
 *
 * Used by framework internals (WebSocket upgrade, SSE upgrade) to resolve the
 * authenticated actor from the raw `Request`. The auth plugin registers its
 * resolver during `setupPost` via `ctx.registrar.setRequestActorResolver(...)`.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `RequestActorResolver`.
 * @throws If no `RequestActorResolver` has been registered (e.g., auth plugin not installed).
 *
 * @remarks
 * **Error handling:** this function throws synchronously with a descriptive message if
 * no resolver is registered. Use it in code paths where a missing resolver is a
 * programming error (e.g., a WebSocket endpoint that requires auth). If the auth plugin
 * is optional in your deployment, use `getRequestActorResolverOrNull()` instead and handle the
 * `null` case explicitly to avoid an unhandled exception at runtime.
 *
 * @example
 * ```ts
 * import { getRequestActorResolver, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const resolver = getRequestActorResolver(getContext(app));
 * const actorId = await resolver.resolveActorId(request);
 * ```
 */
export function getRequestActorResolver(input: ContextCarrier): RequestActorResolver {
  const resolver = resolveContext(input).actorResolver;
  if (resolver === null) {
    throw new Error('No RequestActorResolver registered for this app instance.');
  }
  return resolver;
}

/**
 * Retrieve the `RequestActorResolver` registered on a Slingshot app or context instance,
 * returning `null` if none has been registered.
 *
 * Use this variant when the auth plugin is optional and you want to handle the
 * missing-resolver case explicitly rather than catching an error.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `RequestActorResolver`, or `null` if not set.
 *
 * @remarks
 * **Use case pattern:** prefer `getRequestActorResolverOrNull()` in framework code that
 * conditionally enables auth-gated features (e.g., presence tracking, per-actor
 * rate limiting) only when auth is available:
 *
 * ```ts
 * const resolver = getRequestActorResolverOrNull(ctx);
 * if (resolver) {
 *   const actorId = await resolver.resolveActorId(req);
 *   // enable auth-gated feature
 * } else {
 *   // degrade gracefully — no auth plugin installed
 * }
 * ```
 *
 * For code paths where auth is required and a missing resolver is a bug, use
 * `getRequestActorResolver()` (throwing variant) instead so the error surfaces at the call site
 * rather than failing silently downstream.
 */
export function getRequestActorResolverOrNull(input: ContextCarrier): RequestActorResolver | null {
  return resolveContext(input).actorResolver;
}

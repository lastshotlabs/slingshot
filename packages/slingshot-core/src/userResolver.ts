import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { UserResolver } from './coreContracts';

export type { UserResolver };

// ---------------------------------------------------------------------------
// UserResolver -- resolves a user identity from a raw HTTP request.
// ---------------------------------------------------------------------------

/**
 * Retrieve the `UserResolver` registered on a Slingshot app or context instance.
 *
 * Used by framework internals (WebSocket upgrade, SSE upgrade) to resolve the
 * authenticated user from the raw `Request`. The auth plugin registers its
 * resolver during `setupPost` via `ctx.registrar.setUserResolver(...)`.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `UserResolver`.
 * @throws If no `UserResolver` has been registered (e.g., auth plugin not installed).
 *
 * @remarks
 * **Error handling:** this function throws synchronously with a descriptive message if
 * no resolver is registered. Use it in code paths where a missing resolver is a
 * programming error (e.g., a WebSocket endpoint that requires auth). If the auth plugin
 * is optional in your deployment, use `getUserResolverOrNull()` instead and handle the
 * `null` case explicitly to avoid an unhandled exception at runtime.
 *
 * @example
 * ```ts
 * import { getUserResolver, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const resolver = getUserResolver(getContext(app));
 * const userId = await resolver.resolveUserId(request);
 * ```
 */
export function getUserResolver(input: ContextCarrier): UserResolver {
  const resolver = resolveContext(input).userResolver;
  if (resolver === null) {
    throw new Error('No UserResolver registered for this app instance.');
  }
  return resolver;
}

/**
 * Retrieve the `UserResolver` registered on a Slingshot app or context instance,
 * returning `null` if none has been registered.
 *
 * Use this variant when the auth plugin is optional and you want to handle the
 * missing-resolver case explicitly rather than catching an error.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `UserResolver`, or `null` if not set.
 *
 * @remarks
 * **Use case pattern:** prefer `getUserResolverOrNull()` in framework code that
 * conditionally enables auth-gated features (e.g., presence tracking, per-user
 * rate limiting) only when auth is available:
 *
 * ```ts
 * const resolver = getUserResolverOrNull(ctx);
 * if (resolver) {
 *   const userId = await resolver.resolveUserId(req);
 *   // enable auth-gated feature
 * } else {
 *   // degrade gracefully — no auth plugin installed
 * }
 * ```
 *
 * For code paths where auth is required and a missing resolver is a bug, use
 * `getUserResolver()` (throwing variant) instead so the error surfaces at the call site
 * rather than failing silently downstream.
 */
export function getUserResolverOrNull(input: ContextCarrier): UserResolver | null {
  return resolveContext(input).userResolver;
}

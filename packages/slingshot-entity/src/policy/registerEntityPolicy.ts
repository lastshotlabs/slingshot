import type { Hono } from 'hono';
import { getContext, getContextOrNull } from '@lastshotlabs/slingshot-core';
import type { AppEnv, PolicyResolver } from '@lastshotlabs/slingshot-core';
import { getOrCreateEntityPolicyRegistry } from './entityPolicyRegistry';

/**
 * Register a policy resolver under a named key. Consumers call this from
 * their plugin's `setupMiddleware` phase, **before** any `slingshot-entity`
 * `setupRoutes` runs for entities that reference the key.
 *
 * Registration after the registry has been frozen (which happens at the
 * end of `slingshot-entity.setupRoutes`) throws. This prevents late
 * registration from silently affecting requests in flight.
 *
 * @throws {Error} If the registry has already been frozen.
 * @throws {Error} If a resolver is already registered under the same key.
 *
 * @example
 * ```ts
 * registerEntityPolicy(app, 'polls:sourcePolicy', async (input) => {
 *   const isMember = await checkMembership(input.record?.scopeId, input.userId);
 *   return isMember;
 * });
 * ```
 */
export function registerEntityPolicy<TRecord = unknown, TInput = unknown>(
  app: Hono<AppEnv>,
  key: string,
  resolver: PolicyResolver<TRecord, TInput>,
): void {
  const ctx = getContext(app);
  const registry = getOrCreateEntityPolicyRegistry(ctx.pluginState);
  if (registry.frozen) {
    throw new Error(
      `registerEntityPolicy('${key}'): policy registry is frozen. ` +
        'Resolvers must be registered during setupMiddleware, before slingshot-entity.setupRoutes runs.',
    );
  }
  if (registry.resolvers.has(key)) {
    throw new Error(
      `registerEntityPolicy('${key}'): resolver already registered. ` +
        'Duplicate registration is not supported — compose explicitly via definePolicyDispatch.',
    );
  }
  registry.resolvers.set(key, resolver as PolicyResolver);
}

/**
 * Look up a resolver by key. Used internally by slingshot-entity's
 * `setupRoutes` to thread resolvers into the runtime middleware.
 *
 * Returns `undefined` if no resolver is registered; callers are
 * responsible for treating that as a startup error.
 */
export function getEntityPolicyResolver(
  app: Hono<AppEnv>,
  key: string,
): PolicyResolver | undefined {
  const ctx = getContextOrNull(app);
  if (!ctx) return undefined;
  const registry = getOrCreateEntityPolicyRegistry(ctx.pluginState);
  return registry.resolvers.get(key);
}

/**
 * Freeze the registry. Called once by `slingshot-entity.setupRoutes` after
 * it has resolved every policy key used by every entity. Subsequent
 * `registerEntityPolicy` calls throw.
 */
export function freezeEntityPolicyRegistry(app: Hono<AppEnv>): void {
  const ctx = getContextOrNull(app);
  if (!ctx) return;
  const registry = getOrCreateEntityPolicyRegistry(ctx.pluginState);
  registry.frozen = true;
}

import type { Hono } from 'hono';
import type { AppEnv } from './context';
import { getContext, getContextOrNull } from './context/index';
import type { PolicyResolver } from './entityRouteConfig';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { resolvePluginState } from './pluginState';

/**
 * Plugin-state key owned by `slingshot-entity`.
 */
export const SLINGSHOT_ENTITY_PLUGIN_STATE_KEY = 'slingshot-entity' as const;

/**
 * Sub-slot inside the `slingshot-entity` plugin state object that stores
 * policy resolvers for the current app instance.
 */
export const POLICY_REGISTRY_SLOT = 'policyRegistry' as const;

/**
 * Per-app entity policy registry.
 */
export interface EntityPolicyRegistry {
  readonly resolvers: Map<string, PolicyResolver>;
  frozen: boolean;
}

/**
 * Create a fresh, unfrozen entity policy registry.
 */
export function createEntityPolicyRegistry(): EntityPolicyRegistry {
  return { resolvers: new Map(), frozen: false };
}

interface SlingshotEntityPluginState {
  [POLICY_REGISTRY_SLOT]?: EntityPolicyRegistry;
}

/**
 * Retrieve or create the entity policy registry for the current app instance.
 */
export function getOrCreateEntityPolicyRegistry(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): EntityPolicyRegistry {
  const pluginState = resolvePluginState(input);
  if (!pluginState) {
    throw new Error('[slingshot-entity] pluginState is not available for policy registry access');
  }

  let state = pluginState.get(SLINGSHOT_ENTITY_PLUGIN_STATE_KEY) as
    | SlingshotEntityPluginState
    | undefined;
  if (!state) {
    state = {};
    pluginState.set(SLINGSHOT_ENTITY_PLUGIN_STATE_KEY, state);
  }

  if (!state[POLICY_REGISTRY_SLOT]) {
    state[POLICY_REGISTRY_SLOT] = createEntityPolicyRegistry();
  }

  return state[POLICY_REGISTRY_SLOT];
}

/**
 * Register an entity policy resolver under a named key.
 */
export function registerEntityPolicy<TRecord = unknown, TInput = unknown>(
  app: Hono<AppEnv>,
  key: string,
  resolver: PolicyResolver<TRecord, TInput>,
): void {
  const registry = getOrCreateEntityPolicyRegistry(getContext(app).pluginState);
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
 * Resolve a previously registered entity policy resolver by key.
 */
export function getEntityPolicyResolver(
  app: Hono<AppEnv>,
  key: string,
): PolicyResolver | undefined {
  const ctx = getContextOrNull(app);
  if (!ctx) return undefined;
  return getOrCreateEntityPolicyRegistry(ctx.pluginState).resolvers.get(key);
}

/**
 * Freeze the registry after route assembly so later registrations fail loudly.
 */
export function freezeEntityPolicyRegistry(app: Hono<AppEnv>): void {
  const ctx = getContextOrNull(app);
  if (!ctx) return;
  getOrCreateEntityPolicyRegistry(ctx.pluginState).frozen = true;
}

import type {
  PluginStateCarrier,
  PluginStateMap,
  PolicyResolver,
} from '@lastshotlabs/slingshot-core';
import { publishPluginState, resolvePluginState } from '@lastshotlabs/slingshot-core';

/**
 * Plugin state key under which the policy registry lives on
 * app `pluginState`.
 *
 * Convention: `pluginState` is `Map<string, unknown>` keyed by the owning
 * plugin's `name` field. `slingshot-entity` owns this slot.
 */
export const SLINGSHOT_ENTITY_PLUGIN_STATE_KEY = 'slingshot-entity' as const;

/**
 * Sub-key inside the slingshot-entity plugin state object that holds the
 * policy registry.
 */
export const POLICY_REGISTRY_SLOT = 'policyRegistry' as const;

/**
 * Per-app policy registry. Registered during consumer `setupMiddleware`,
 * frozen before `setupRoutes` runs, cleared by `ctx.clear()` for test isolation.
 */
export interface EntityPolicyRegistry {
  readonly resolvers: Map<string, PolicyResolver>;
  frozen: boolean;
}

/** Create a fresh, unfrozen policy registry. */
export function createEntityPolicyRegistry(): EntityPolicyRegistry {
  return { resolvers: new Map(), frozen: false };
}

interface SlingshotEntityPluginState {
  [POLICY_REGISTRY_SLOT]?: EntityPolicyRegistry;
}

function ensureMutableEntityPluginState(
  pluginState: PluginStateMap,
  state: SlingshotEntityPluginState | undefined,
): SlingshotEntityPluginState {
  if (!state) {
    const nextState: SlingshotEntityPluginState = {};
    publishPluginState(pluginState, SLINGSHOT_ENTITY_PLUGIN_STATE_KEY, nextState);
    return nextState;
  }

  if (Object.isExtensible(state)) {
    return state;
  }

  const nextState: SlingshotEntityPluginState = { ...state };
  publishPluginState(pluginState, SLINGSHOT_ENTITY_PLUGIN_STATE_KEY, nextState);
  return nextState;
}

/**
 * Retrieve or create the policy registry for the given app `pluginState`.
 * Called by `registerEntityPolicy` and by `slingshot-entity`'s `setupRoutes`.
 */
export function getOrCreateEntityPolicyRegistry(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): EntityPolicyRegistry {
  const pluginState = resolvePluginState(input);
  if (!pluginState) {
    throw new Error('[slingshot-entity] pluginState is not available for policy registry access');
  }

  const existingState = pluginState.get(SLINGSHOT_ENTITY_PLUGIN_STATE_KEY) as
    | SlingshotEntityPluginState
    | undefined;
  const state = ensureMutableEntityPluginState(pluginState, existingState);
  if (!state[POLICY_REGISTRY_SLOT]) {
    state[POLICY_REGISTRY_SLOT] = createEntityPolicyRegistry();
  }
  return state[POLICY_REGISTRY_SLOT];
}

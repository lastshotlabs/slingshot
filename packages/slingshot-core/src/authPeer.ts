import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

/**
 * Stable plugin-state key published by `slingshot-auth`.
 *
 * Packages that need only a narrow auth-facing peer contract should depend on
 * this key and the accessors below instead of spelunking for raw string keys.
 */
export const AUTH_PLUGIN_STATE_KEY = 'slingshot-auth' as const;

/**
 * Minimal peer-facing auth runtime shape shared through `ctx.pluginState`.
 *
 * This intentionally models only the cross-package surface needed by packages
 * that coordinate with auth without importing `@lastshotlabs/slingshot-auth`.
 */
export interface AuthRuntimePeer {
  readonly adapter: object;
  readonly config?: {
    readonly primaryField?: string;
    readonly emailVerification?: {
      readonly required?: boolean;
    } | null;
  } | null;
}

/**
 * Retrieve the auth runtime peer from plugin state.
 */
export function getAuthRuntimePeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): AuthRuntimePeer {
  const runtime = getAuthRuntimePeerOrNull(input);
  if (!runtime) {
    throw new Error('[slingshot-auth] auth runtime peer is not available in pluginState');
  }
  return runtime;
}

/**
 * Retrieve the auth runtime peer from plugin state when auth has published it.
 */
export function getAuthRuntimePeerOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): AuthRuntimePeer | null {
  const pluginState = getPluginStateOrNull(input);
  const runtime = pluginState?.get(AUTH_PLUGIN_STATE_KEY);
  if (typeof runtime !== 'object' || runtime === null) {
    return null;
  }

  const adapter = Reflect.get(runtime, 'adapter');
  if (typeof adapter !== 'object' || adapter === null) {
    return null;
  }

  return runtime as AuthRuntimePeer;
}

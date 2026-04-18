import type { Hono } from 'hono';
import { getContext } from '@lastshotlabs/slingshot-core';
import type { DeepLinksPluginState } from './state';
import { DEEP_LINKS_PLUGIN_STATE_KEY } from './stateKey';

/**
 * Read the compiled deep-links plugin state from an app.
 *
 * @param app - Hono app instance created with Slingshot context attached.
 * @returns The deep-links plugin state, or `null` when the plugin is absent.
 */
export function getDeepLinksState(app: Hono): DeepLinksPluginState | null {
  return (
    (getContext(app).pluginState.get(DEEP_LINKS_PLUGIN_STATE_KEY) as DeepLinksPluginState | null) ??
    null
  );
}

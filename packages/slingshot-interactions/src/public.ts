/**
 * Public contract for `slingshot-interactions`.
 *
 * Cross-package consumers resolve `InteractionsRuntimeCap` through
 * `ctx.capabilities.require(...)` to read the active interactions runtime
 * (handler registry, peers, rate limiter). The legacy plugin-state slot at
 * `INTERACTIONS_PLUGIN_STATE_KEY` is still published in parallel during the
 * bridge period.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { InteractionsPluginState } from './state';

/** Provider-owned package contract for `slingshot-interactions`. */
export const Interactions = definePackageContract('slingshot-interactions');

/**
 * Capability handle for the interactions runtime state.
 *
 * Cross-package consumers resolve it via
 * `ctx.capabilities.require(InteractionsRuntimeCap)`. The legacy
 * `INTERACTIONS_PLUGIN_STATE_KEY` plugin-state slot is still published in
 * parallel during the bridge period; new consumers should prefer the cap.
 */
export const InteractionsRuntimeCap = Interactions.capability<InteractionsPluginState>('runtime');

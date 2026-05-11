/**
 * Public contract for `slingshot-assets`.
 *
 * Cross-package consumers resolve `AssetsRuntimeCap` through `ctx.capabilities.require(...)`
 * to fetch the bundled assets adapter, storage adapter, and config.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { AssetsPluginState } from './types';

/** Provider-owned package contract for `slingshot-assets`. */
export const Assets = definePackageContract('slingshot-assets');

/**
 * Capability handle for the assets plugin runtime.
 *
 * Cross-package consumers resolve it through `ctx.capabilities.require(AssetsRuntimeCap)`
 * to fetch the bundled assets adapter, storage adapter, and resolved config.
 */
export const AssetsRuntimeCap = Assets.capability<AssetsPluginState>('runtime');

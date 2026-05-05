/**
 * Public contract for `slingshot-assets`.
 *
 * Cross-package consumers resolve `AssetsRuntimeCap` through `ctx.capabilities.require(...)`
 * to fetch the bundled assets adapter, storage adapter, and config.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { AssetsPluginState } from './types';

export const Assets = definePackageContract('slingshot-assets');

export const AssetsRuntimeCap = Assets.capability<AssetsPluginState>('runtime');

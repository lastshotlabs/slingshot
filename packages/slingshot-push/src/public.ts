/**
 * Public contract for `slingshot-push`.
 *
 * Cross-package consumers (notably `slingshot-chat` for formatter registration) resolve
 * `PushRuntimeCap` through `ctx.capabilities.require(...)`.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { PushPluginState } from './state';

/** Provider-owned package contract for `slingshot-push`. */
export const Push = definePackageContract('slingshot-push');

/**
 * Capability handle for the push notifications runtime.
 *
 * Cross-package consumers (notably `slingshot-chat` for formatter registration) resolve
 * it through `ctx.capabilities.require(PushRuntimeCap)`.
 */
export const PushRuntimeCap = Push.capability<PushPluginState>('pushRuntime');

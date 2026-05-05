/**
 * Public contract for `slingshot-push`.
 *
 * Cross-package consumers (notably `slingshot-chat` for formatter registration) resolve
 * `PushRuntimeCap` through `ctx.capabilities.require(...)`.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { PushPluginState } from './state';

export const Push = definePackageContract('slingshot-push');

export const PushRuntimeCap = Push.capability<PushPluginState>('pushRuntime');

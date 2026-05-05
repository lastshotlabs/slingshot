/**
 * Public contract for `slingshot-ssr`.
 *
 * Cross-package consumers (server actions, route handlers, peer plugins) resolve
 * `IsrInvalidatorsCap` through `ctx.capabilities.require(...)` to invalidate paths
 * and tags on the active ISR cache adapter.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { IsrInvalidators } from './isr/revalidate';

export const Ssr = definePackageContract('slingshot-ssr');

export const IsrInvalidatorsCap = Ssr.capability<IsrInvalidators>('isrInvalidators');

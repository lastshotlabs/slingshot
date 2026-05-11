/**
 * Public contract for `slingshot-ssr`.
 *
 * Cross-package consumers (server actions, route handlers, peer plugins) resolve
 * `IsrInvalidatorsCap` through `ctx.capabilities.require(...)` to invalidate paths
 * and tags on the active ISR cache adapter.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { IsrInvalidators } from './isr/revalidate';

/** Provider-owned package contract for `slingshot-ssr`. */
export const Ssr = definePackageContract('slingshot-ssr');

/**
 * Capability handle for the ISR invalidators (path and tag invalidation).
 *
 * Cross-package consumers (server actions, route handlers, peer plugins) resolve it
 * through `ctx.capabilities.require(IsrInvalidatorsCap)` to invalidate paths and tags
 * on the active ISR cache adapter.
 */
export const IsrInvalidatorsCap = Ssr.capability<IsrInvalidators>('isrInvalidators');

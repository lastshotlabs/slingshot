/**
 * Public contract for `slingshot-webhooks`.
 *
 * Cross-package consumers resolve `WebhooksAdapterCap` through `ctx.capabilities.require(...)`
 * to send/manage outbound webhook deliveries through the unified adapter.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { WebhookAdapter } from './types/adapter';

/** Provider-owned package contract for `slingshot-webhooks`. */
export const Webhooks = definePackageContract('slingshot-webhooks');

/**
 * Capability handle for the unified webhook adapter.
 *
 * Cross-package consumers resolve it through `ctx.capabilities.require(WebhooksAdapterCap)`
 * to send and manage outbound webhook deliveries.
 */
export const WebhooksAdapterCap = Webhooks.capability<WebhookAdapter>('adapter');

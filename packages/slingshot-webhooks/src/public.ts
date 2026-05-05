/**
 * Public contract for `slingshot-webhooks`.
 *
 * Cross-package consumers resolve `WebhookAdapterCap` through `ctx.capabilities.require(...)`
 * to send/manage outbound webhook deliveries through the unified adapter.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { WebhookAdapter } from './types/adapter';

export const Webhooks = definePackageContract('slingshot-webhooks');

export const WebhookAdapterCap = Webhooks.capability<WebhookAdapter>('adapter');

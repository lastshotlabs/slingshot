import { definePluginStateKey } from '@lastshotlabs/slingshot-core';
import type { WebhookAdapter } from './adapter';

/** Stable plugin-state key published by `slingshot-webhooks`. */
export const WEBHOOKS_PLUGIN_STATE_KEY = 'slingshot-webhooks' as const;

/** Typed plugin-state key for the webhooks adapter slot. */
export const WEBHOOKS_RUNTIME_KEY = definePluginStateKey<WebhookAdapter>(WEBHOOKS_PLUGIN_STATE_KEY);

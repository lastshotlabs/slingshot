/**
 * Named constants for the two route groups mounted by the webhook plugin.
 * Pass values to `WebhookPluginConfig.disableRoutes` to skip mounting specific route groups.
 *
 * @example
 * ```ts
 * import { WEBHOOK_ROUTES } from '@lastshotlabs/slingshot-webhooks';
 *
 * createWebhookPlugin({
 *   ...,
 *   disableRoutes: [WEBHOOK_ROUTES.ENDPOINTS], // skip the management API
 * });
 * ```
 */
export const WEBHOOK_ROUTES = {
  /** The endpoint management API (`/webhooks/endpoints`). */
  ENDPOINTS: 'endpoints',
  /** The inbound webhook receiver (`/webhooks/inbound/:provider`). */
  INBOUND: 'inbound',
} as const;

/**
 * Union of valid route group names that can be passed to `WebhookPluginConfig.disableRoutes`.
 */
export type WebhookRoute = (typeof WEBHOOK_ROUTES)[keyof typeof WEBHOOK_ROUTES];

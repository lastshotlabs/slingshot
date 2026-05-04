/**
 * Public contract for `slingshot-notifications`.
 *
 * Other packages and plugins consume this surface through typed capability handles
 * instead of reaching into `NOTIFICATIONS_PLUGIN_STATE_KEY` directly. The plugin
 * publishes implementations during `setupPost` via `registerPluginCapabilities`;
 * consumers fetch them through `ctx.capabilities.require(...)` or
 * `services.capabilities.require(...)` (in out-of-request hooks).
 *
 * Legacy state-key access (`getNotificationsStateOrNull`) remains supported for
 * backward compatibility, but new code should consume the contract.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { DeliveryAdapter, NotificationBuilder } from '@lastshotlabs/slingshot-core';

/** Provider-owned contract for `slingshot-notifications`. */
export const Notifications = definePackageContract('slingshot-notifications');

/**
 * Capability for creating source-scoped notification builders.
 *
 * Consumers do `ctx.capabilities.require(NotificationsBuilderFactory)({ source: 'my-plugin' })`
 * to get a builder bound to their plugin name. Each builder publishes notifications,
 * resolves preferences, and applies rate limits on behalf of the calling source.
 */
export const NotificationsBuilderFactory = Notifications.capability<
  (opts: { source: string }) => NotificationBuilder
>('builderFactory');

/**
 * Capability for registering a delivery adapter.
 *
 * Plugins like `slingshot-push` and mailers register adapters that fire on every
 * dispatched notification. The notifications plugin invokes registered adapters
 * via the in-process event bus when a notification is created and dispatched.
 */
export interface NotificationsDeliveryRegistry {
  register(adapter: DeliveryAdapter): void;
}
export const NotificationsDeliveryRegistry =
  Notifications.capability<NotificationsDeliveryRegistry>('deliveryRegistry');

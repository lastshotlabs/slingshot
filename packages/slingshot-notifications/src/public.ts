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
import type { DispatcherHealth } from './dispatcher';

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

/**
 * Aggregated health snapshot for the notifications package.
 */
export interface NotificationsHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /** Whether the notification entity adapter was resolved. */
    readonly adapterAvailable: boolean;
    /** Whether the preference entity adapter was resolved. */
    readonly preferencesAdapterAvailable: boolean;
    /** Number of registered delivery adapters. */
    readonly deliveryAdapterCount: number;
    /** Configured rate-limit backend name. */
    readonly rateLimitBackend: string;
    /** Delegated dispatcher health snapshot. */
    readonly dispatcherHealth: DispatcherHealth;
  };
}

/**
 * Capability for reading the aggregated notifications health snapshot.
 *
 * Consumers resolve via `ctx.capabilities.require(NotificationsHealthCap)()` and
 * receive a frozen `NotificationsHealth` representing adapter, delivery, rate-limit,
 * and dispatcher state at call time.
 */
export const NotificationsHealthCap =
  Notifications.capability<() => NotificationsHealth>('health');

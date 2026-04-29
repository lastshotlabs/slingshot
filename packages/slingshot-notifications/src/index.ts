import './events';

/**
 * Create the notifications plugin and wire entity storage, routing, and delivery hooks.
 */
export { createNotificationsPlugin } from './plugin';
/**
 * Plugin state key used to retrieve the notifications runtime state from app context.
 */
export { NOTIFICATIONS_PLUGIN_STATE_KEY } from './state';
/**
 * Runtime state exposed by the notifications plugin.
 */
export type { NotificationsPluginState } from './state';
/**
 * Zod schema used to validate notifications plugin configuration.
 */
export { notificationsPluginConfigSchema } from './types/config';
/**
 * Configuration shape accepted by `createNotificationsPlugin()`.
 */
export type { NotificationsPluginConfig } from './types/config';
/**
 * Notification entity config and generated operations.
 */
export { Notification, notificationOperations } from './entities/notification';
/**
 * Notification preference entity config and generated operations.
 */
export { NotificationPreference, notificationPreferenceOperations } from './entities/preference';
/**
 * Test factories for notification and notification preference records.
 */
export { notificationFactories, notificationPreferenceFactories } from './entities/factories';
/**
 * Adapter contracts, record types, event payloads, and notify input shapes.
 */
export type {
  DeliveryAdapter,
  NotificationAdapter,
  NotificationCreatedEventPayload,
  NotificationPreferenceAdapter,
  NotificationPreferenceRecord,
  NotificationPriority,
  NotificationRecord,
  NotifyInput,
  NotifyManyInput,
  ResolvedPreference,
} from './types';
/**
 * Fluent builder contract for composing notification payloads.
 */
export type { NotificationBuilder } from './builder';
/**
 * Create a fluent notification builder.
 */
export { createNotificationBuilder } from './builder';
/**
 * Dispatcher adapter contracts, retry options, and circuit-breaker options.
 */
export type {
  CreateIntervalDispatcherOptions,
  DispatcherAdapter,
  DispatcherBreakerOptions,
  DispatcherRetryOptions,
} from './dispatcher';
/**
 * Create an interval-based notification dispatcher.
 */
export { createIntervalDispatcher } from './dispatcher';
/**
 * Notification data size guard and helper for freezing payload data.
 */
export { NotificationDataTooLargeError, freezeNotificationData } from './data';
/**
 * Preference resolution helpers for delivery channels, priorities, and quiet hours.
 */
export { resolvePreferences, resolveEffectivePriority, isWithinQuietHours } from './preferences';

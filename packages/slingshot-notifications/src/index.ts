export { createNotificationsPlugin } from './plugin';
export { NOTIFICATIONS_PLUGIN_STATE_KEY } from './state';
export type { NotificationsPluginState } from './state';
export { notificationsPluginConfigSchema } from './types/config';
export type { NotificationsPluginConfig } from './types/config';
export { Notification, notificationOperations } from './entities/notification';
export { NotificationPreference, notificationPreferenceOperations } from './entities/preference';
export { notificationFactories, notificationPreferenceFactories } from './entities/factories';
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
export type { NotificationBuilder } from './builder';
export { createNotificationBuilder } from './builder';
export type { DispatcherAdapter } from './dispatcher';
export { createIntervalDispatcher } from './dispatcher';
export { NotificationDataTooLargeError, freezeNotificationData } from './data';
export { resolvePreferences, resolveEffectivePriority, isWithinQuietHours } from './preferences';

import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { Notification, notificationOperations } from './notification';
import { NotificationPreference, notificationPreferenceOperations } from './preference';

/** Entity runtime factories (adapter, router, routes) for the Notification entity. */
export const notificationFactories = createEntityFactories(
  Notification,
  notificationOperations.operations,
);

/** Entity runtime factories (adapter, router, routes) for the NotificationPreference entity. */
export const notificationPreferenceFactories = createEntityFactories(
  NotificationPreference,
  notificationPreferenceOperations.operations,
);

import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { Notification, notificationOperations } from './notification';
import { NotificationPreference, notificationPreferenceOperations } from './preference';

export const notificationFactories = createEntityFactories(
  Notification,
  notificationOperations.operations,
);

export const notificationPreferenceFactories = createEntityFactories(
  NotificationPreference,
  notificationPreferenceOperations.operations,
);

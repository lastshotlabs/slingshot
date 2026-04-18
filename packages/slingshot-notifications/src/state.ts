import type { NotificationsPeerState } from '@lastshotlabs/slingshot-core';
import type { DispatcherAdapter } from './dispatcher';
import type { NotificationAdapter, NotificationPreferenceAdapter } from './types';
import type { NotificationsPluginConfig } from './types/config';

export { NOTIFICATIONS_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';

export interface NotificationsPluginState extends NotificationsPeerState {
  readonly config: Readonly<NotificationsPluginConfig>;
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly dispatcher: DispatcherAdapter;
}

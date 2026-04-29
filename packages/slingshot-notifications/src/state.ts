import type { NotificationsPeerState } from '@lastshotlabs/slingshot-core';
import type { DispatcherAdapter } from './dispatcher';
import type { NotificationAdapter, NotificationPreferenceAdapter } from './types';
import type { NotificationsPluginConfig } from './types/config';

/** Context key used to store and retrieve the notifications plugin state from the app context. */
export { NOTIFICATIONS_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';

/** Runtime state held by the notifications plugin, exposing config, adapters, and the dispatcher. */
export interface NotificationsPluginState extends NotificationsPeerState {
  readonly config: Readonly<NotificationsPluginConfig>;
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly dispatcher: DispatcherAdapter;
}

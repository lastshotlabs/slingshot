// Internal plugin state types kept for `getHealth()` and the dispatcher loop.
// The legacy `NOTIFICATIONS_PLUGIN_STATE_KEY` peer-state publish was removed in favor
// of the typed `Notifications` package contract — see `./public.ts`.

import type { DispatcherAdapter } from './dispatcher';
import type { NotificationAdapter, NotificationPreferenceAdapter } from './types';
import type { NotificationsPluginConfig } from './types/config';

/** Closure-scoped runtime state held by the notifications plugin. Not published. */
export interface NotificationsPluginState {
  readonly config: Readonly<NotificationsPluginConfig>;
  readonly notifications: NotificationAdapter;
  readonly preferences: NotificationPreferenceAdapter;
  readonly dispatcher: DispatcherAdapter;
}

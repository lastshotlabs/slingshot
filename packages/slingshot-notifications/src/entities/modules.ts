/**
 * Package-authoring entity modules for the notification entities.
 *
 * Each module uses `wiring: { mode: 'factories', factories, onAdapter }` so
 * the package's dispatcher, builder factory, and TTL sweep all read from the
 * SAME adapter instance that the framework mounts for entity routes.
 *
 * This sharing is critical under memory storage: a second `resolveRepo` call
 * would instantiate a fresh `Map`-backed store, causing the dispatcher to
 * poll a different bucket than the entity routes write to.
 *
 * @internal
 */
import { entity } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { notificationFactories, notificationPreferenceFactories } from './factories';
import { Notification, notificationOperations } from './notification';
import { NotificationPreference, notificationPreferenceOperations } from './preference';

/**
 * Build the two notification entity modules wired to share their resolved
 * adapters with the caller through `onAdapter` callbacks. Each call yields a
 * fresh set — closures captured by `onAdapter` are caller-owned, so multiple
 * package instances stay isolated (Rule 3).
 */
export function buildNotificationsEntityModules(callbacks: {
  onNotificationAdapter: (adapter: BareEntityAdapter) => void;
  onPreferenceAdapter: (adapter: BareEntityAdapter) => void;
}) {
  const notificationModule = entity({
    config: Notification,
    operations: notificationOperations,
    wiring: {
      mode: 'factories',
      factories: notificationFactories,
      onAdapter: callbacks.onNotificationAdapter,
    },
  });

  const notificationPreferenceModule = entity({
    config: NotificationPreference,
    operations: notificationPreferenceOperations,
    wiring: {
      mode: 'factories',
      factories: notificationPreferenceFactories,
      onAdapter: callbacks.onPreferenceAdapter,
    },
  });

  return { notificationModule, notificationPreferenceModule };
}

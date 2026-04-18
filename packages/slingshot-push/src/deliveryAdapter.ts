import type { DeliveryAdapter } from '@lastshotlabs/slingshot-core';
import type { PushRouter } from './router';
import type { CompiledPushFormatterTable } from './state';
import type { NotificationDefaults } from './types/models';

/**
 * Create a notifications delivery adapter backed by the push router.
 *
 * @param opts - Router, formatter table, and optional defaults.
 * @returns A delivery adapter suitable for registration with
 *   `slingshot-notifications`.
 */
export function createPushDeliveryAdapter(opts: {
  router: PushRouter;
  formatters: CompiledPushFormatterTable;
  skipSources?: string[];
  defaults?: NotificationDefaults;
}): DeliveryAdapter {
  const skipSources = new Set(opts.skipSources ?? []);

  return {
    async deliver(event) {
      if (!event.preferences.pushEnabled) return;
      if (skipSources.has(event.notification.source)) return;

      const notification = event.notification;
      const message = opts.formatters.format(notification, {
        icon: opts.defaults?.icon,
        badge: opts.defaults?.badge,
        url: notification.targetId != null ? notification.targetId : opts.defaults?.defaultUrl,
      });

      await opts.router.sendToUser(notification.userId, message, {
        tenantId: notification.tenantId ?? '',
        notificationId: notification.id,
      });
    },
  };
}

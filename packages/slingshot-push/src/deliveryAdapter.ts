import type { DeliveryAdapter } from '@lastshotlabs/slingshot-core';
import type { PushRouter } from './router';
import type { CompiledPushFormatterTable } from './state';
import type { NotificationDefaults } from './types/models';

/**
 * Create a notifications delivery adapter backed by the push router.
 *
 * @param opts - Router, formatter table, optional defaults, and an optional
 *   per-dispatch `providerTimeoutMs` override that the adapter forwards into
 *   `router.sendToUser` so dispatcher-side timeouts win over router-level
 *   defaults when the host application wants tighter SLOs for one
 *   notification class.
 * @returns A delivery adapter suitable for registration with
 *   `slingshot-notifications`.
 */
export function createPushDeliveryAdapter(opts: {
  router: PushRouter;
  formatters: CompiledPushFormatterTable;
  skipSources?: string[];
  defaults?: NotificationDefaults;
  /**
   * Per-call override forwarded into `router.sendToUser`. When omitted, the
   * router falls back to its construction-time default.
   */
  providerTimeoutMs?: number;
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
        providerTimeoutMs: opts.providerTimeoutMs,
      });
    },
  };
}

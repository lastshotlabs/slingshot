import type {
  EventEnvelope,
  SlingshotEventBus,
  SlingshotEvents,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import { resolveWebhookDeliveries } from '../manifest/runtime';
import type { WebhookAdapter } from '../types/adapter';
import type { WebhookPluginConfig } from '../types/config';
import type { WebhookQueue } from '../types/queue';
import { matchGlob } from './globMatch';

/**
 * Subscribes the webhook plugin to registry-backed webhook-visible events and
 * returns an array of unsubscribe functions.
 */
export function wireEventSubscriptions(
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  config: WebhookPluginConfig,
  queue: WebhookQueue,
  adapter: WebhookAdapter,
): Array<() => void> {
  const patterns = config.events ?? ['*'];
  const subscribedKeys = events
    .list()
    .filter(definition =>
      definition.exposure.some(
        exposure =>
          exposure === 'tenant-webhook' ||
          exposure === 'user-webhook' ||
          exposure === 'app-webhook',
      ),
    )
    .map(definition => definition.key)
    .filter(key => patterns.some(pattern => matchGlob(pattern, key as string)));
  const subscriptionOpts: SubscriptionOpts | undefined = config.busSubscription?.durable
    ? {
        durable: true,
        name: config.busSubscription.name,
      }
    : undefined;
  const maxAttempts = config.queueConfig?.maxAttempts ?? 5;

  return subscribedKeys.map(key => {
    const handler = async (envelope: EventEnvelope<typeof key>) => {
      let deliveries;
      try {
        deliveries = await resolveWebhookDeliveries(
          adapter,
          events.definitions,
          envelope,
          maxAttempts,
        );
      } catch (error) {
        console.error(
          `[slingshot-webhooks] failed to resolve webhook deliveries for "${String(key)}"`,
          error,
        );
        return;
      }

      for (const resolved of deliveries) {
        try {
          await queue.enqueue(resolved.job);
        } catch (err) {
          await adapter.updateDelivery(resolved.delivery.id, {
            status: 'dead',
            lastAttempt: {
              attemptedAt: new Date().toISOString(),
              error: 'enqueue failed: ' + String(err),
            },
          });
        }
      }
    };
    bus.onEnvelope(key, handler, subscriptionOpts);
    if (subscriptionOpts?.durable) {
      return () => {};
    }
    return () => bus.offEnvelope(key, handler);
  });
}

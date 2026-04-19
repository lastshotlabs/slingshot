import type {
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import { WEBHOOK_DEFAULT_SUBSCRIBABLE_EVENTS } from '../subscribableEvents';
import type { WebhookAdapter } from '../types/adapter';
import type { WebhookPluginConfig } from '../types/config';
import type { WebhookDelivery } from '../types/models';
import type { WebhookQueue } from '../types/queue';
import { matchGlob } from './globMatch';

/**
 * Subscribes the webhook plugin to all configured bus events and returns an array
 * of unsubscribe functions.
 *
 * For each bus event that matches the configured `config.events` filter, the function
 * attaches a handler that queries the adapter for matching active endpoints and enqueues
 * a delivery for each one.
 *
 * @param bus - The application event bus.
 * @param config - Plugin configuration (events, queueConfig).
 * @param queue - The delivery queue to enqueue jobs to.
 * @param adapter - The webhook adapter for querying endpoints and creating delivery records.
 * @returns An array of `() => void` unsubscribe functions — call all of them during teardown.
 */
export function wireEventSubscriptions(
  bus: SlingshotEventBus,
  config: WebhookPluginConfig,
  queue: WebhookQueue,
  adapter: WebhookAdapter,
): Array<() => void> {
  // Deduplicate before subscribing
  const universe = [
    ...new Set([...WEBHOOK_DEFAULT_SUBSCRIBABLE_EVENTS, ...(config.extraEventKeys ?? [])]),
  ] as ReadonlyArray<keyof SlingshotEventMap>;

  const patterns = config.events ?? ['*'];
  const subscribedKeys = universe.filter(key =>
    patterns.some(pattern => matchGlob(pattern, key as string)),
  );
  const subscriptionOpts: SubscriptionOpts | undefined = config.busSubscription?.durable
    ? {
        durable: true,
        name: config.busSubscription.name,
      }
    : undefined;

  return subscribedKeys.map(key => {
    const handler = async (_payload: SlingshotEventMap[typeof key]) => {
      let endpoints: Awaited<ReturnType<typeof adapter.findEndpointsForEvent>>;
      try {
        endpoints = await adapter.findEndpointsForEvent(key as string);
      } catch {
        return; // adapter failure — nothing to do, avoid crashing the process
      }
      const payload = JSON.stringify(_payload);
      const maxAttempts = config.queueConfig?.maxAttempts ?? 5;
      for (const endpoint of endpoints) {
        let delivery: WebhookDelivery | undefined;
        try {
          delivery = await adapter.createDelivery({
            endpointId: endpoint.id,
            event: key as string,
            payload,
            maxAttempts,
          });
          await queue.enqueue({
            deliveryId: delivery.id,
            endpointId: endpoint.id,
            url: endpoint.url,
            secret: endpoint.secret,
            event: key as string,
            payload,
            attempts: 0,
          });
        } catch (err) {
          if (delivery) {
            await adapter.updateDelivery(delivery.id, {
              status: 'dead',
              lastAttempt: {
                attemptedAt: new Date().toISOString(),
                error: 'enqueue failed: ' + String(err),
              },
            });
          }
        }
      }
    };
    bus.on(
      key,
      handler as (payload: SlingshotEventMap[typeof key]) => void | Promise<void>,
      subscriptionOpts,
    );
    if (subscriptionOpts?.durable) {
      return () => {};
    }
    return () => bus.off(key, handler as (payload: SlingshotEventMap[typeof key]) => void);
  });
}

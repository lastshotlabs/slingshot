import type {
  EventEnvelope,
  SlingshotEventBus,
  SlingshotEvents,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';
import { type RuntimeLogger, resolveWebhookDeliveries } from '../manifest/runtime';
import type { WebhookAdapter } from '../types/adapter';
import type { WebhookPluginConfig } from '../types/config';
import type { WebhookQueue } from '../types/queue';
import { matchGlob } from './globMatch';

/**
 * Optional logger surface accepted by {@link wireEventSubscriptions}. Falls
 * back to a `console`-backed JSON line emitter when not supplied.
 */
export interface EventWiringLogger {
  error(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

const eventWiringLogger = createConsoleLogger({ base: { component: 'slingshot-webhooks' } });

/**
 * Emit a structured log line with a stable shape so production log
 * aggregators can index by `endpointId`, `deliveryId`, and `event`.
 */
function defaultStructuredLog(
  level: 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void {
  if (level === 'error') {
    eventWiringLogger.error(message, fields);
  } else {
    eventWiringLogger.warn(message, fields);
  }
}

/**
 * Subscribes the webhook plugin to registry-backed webhook-visible events and
 * returns an array of unsubscribe functions.
 *
 * @param logger - Optional structured logger. When omitted, error and warn
 *   diagnostics are emitted as JSON lines on `console`.
 */
export function wireEventSubscriptions(
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  config: WebhookPluginConfig,
  queue: WebhookQueue,
  adapter: WebhookAdapter,
  logger?: EventWiringLogger,
): Array<() => void> {
  const log = (level: 'warn' | 'error', message: string, fields: Record<string, unknown>) => {
    if (logger) {
      const payload = { message, ...fields };
      if (level === 'error') logger.error(payload);
      else logger.warn(payload);
      return;
    }
    defaultStructuredLog(level, message, fields);
  };

  const runtimeLogger: RuntimeLogger = {
    error(message, fields) {
      log('error', message, fields ?? {});
    },
    warn(message, fields) {
      log('warn', message, fields ?? {});
    },
  };
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
          runtimeLogger,
        );
      } catch (error) {
        log('error', 'failed to resolve webhook deliveries', {
          event: String(key),
          eventId: envelope.meta.eventId,
          err: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      for (const resolved of deliveries) {
        try {
          await queue.enqueue(resolved.job);
        } catch (err) {
          // P-WEBHOOKS-8: enqueue failure is operationally distinct from
          // the queue running and exhausting attempts. Do NOT mark `dead`
          // — emit `webhook:enqueueFailed` so apps can retry with a
          // different queue or persist for manual reconciliation. Leave
          // the delivery in `pending` so a sweep can re-enqueue.
          log('error', 'failed to enqueue webhook delivery', {
            event: String(key),
            eventId: envelope.meta.eventId,
            endpointId: resolved.endpoint.id,
            deliveryId: resolved.delivery.id,
            attempt: 0,
            err: err instanceof Error ? err.message : String(err),
          });
          try {
            bus.emit('webhook:enqueueFailed', {
              deliveryId: resolved.delivery.id,
              endpointId: resolved.endpoint.id,
              event: String(key),
              eventId: envelope.meta.eventId,
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // bus emission must not poison the loop
          }
        }
      }
    };
    bus.onEnvelope(key, handler, subscriptionOpts);
    return () => bus.offEnvelope(key, handler);
  });
}

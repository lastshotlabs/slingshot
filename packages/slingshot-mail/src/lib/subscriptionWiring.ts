import type {
  EventEnvelope,
  SlingshotEventBus,
  SlingshotEventMap,
} from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import type { MailPluginConfig, MailSubscription } from '../types/config';
import type { MailSubscriptionDrop } from '../types/config';
import type { MailAddress, MailMessage } from '../types/provider';
import type { MailQueue } from '../types/queue';
import { resolveAndInterpolateSubject } from './subjectResolution';

const DEFAULT_SUBSCRIPTION_ENQUEUE_TIMEOUT_MS = 30_000;

/**
 * Thrown at plugin startup when a subscription's template cannot be found in the
 * configured renderer. Lets callers fail fast instead of waiting for the first
 * matching event to fire at runtime.
 */
export class MailTemplateNotFoundError extends Error {
  constructor(
    public readonly templateName: string,
    public readonly event: string,
  ) {
    super(
      `[slingshot-mail] Template "${templateName}" not found for subscription on event "${event}"`,
    );
    this.name = 'MailTemplateNotFoundError';
  }
}

/**
 * Returns the stable subscription identifier used to derive idempotency keys.
 * Falls back to `${event}:${template}` when `subscription.id` is not provided so
 * idempotency works for callers that haven't opted into explicit ids.
 */
function resolveSubscriptionId(subscription: MailSubscription): string {
  return subscription.id ?? `${String(subscription.event)}:${subscription.template}`;
}

/**
 * Validates that every subscription's `template` is known to the configured renderer.
 * Throws a `MailTemplateNotFoundError` listing the first missing template so callers
 * can surface the misconfiguration at startup instead of at first event delivery.
 *
 * @param config - Plugin configuration containing the renderer and subscriptions.
 * @throws {MailTemplateNotFoundError} When any subscription template is unknown.
 */
export async function validateSubscriptionTemplates(config: MailPluginConfig): Promise<void> {
  if (!config.renderer.listTemplates) return;
  const subscriptions = config.subscriptions ?? [];
  if (subscriptions.length === 0) return;
  const available = new Set(await config.renderer.listTemplates());
  for (const sub of subscriptions) {
    if (!available.has(sub.template)) {
      throw new MailTemplateNotFoundError(sub.template, String(sub.event));
    }
  }
}

async function notifySubscriptionDrop(
  config: MailPluginConfig,
  drop: MailSubscriptionDrop,
): Promise<void> {
  try {
    await config.onSubscriptionDrop?.(drop);
  } catch (err) {
    console.error('[slingshot-mail] onSubscriptionDrop callback failed:', err);
  }
}

async function enqueueWithTimeout<T>(op: Promise<T>, timeoutMs: number, event: string): Promise<T> {
  if (timeoutMs <= 0) return op;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`mail subscription enqueue timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('timed out')) {
      err.message = `${err.message} for event ${event}`;
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Subscribes the mail plugin to all configured bus event subscriptions and returns
 * an array of unsubscribe functions for teardown.
 *
 * For each `MailSubscription` in `config.subscriptions`, attaches a bus handler that
 * renders the configured template and enqueues a delivery when the event fires.
 * Supports both transient and durable (BullMQ-backed) subscriptions.
 *
 * @param bus - The application event bus.
 * @param config - Plugin configuration containing subscriptions, renderer, and from address.
 * @param queue - The delivery queue to enqueue rendered messages to.
 * @returns An array of `() => void` unsubscribe functions — call all of them during teardown.
 */
export function wireSubscriptions(
  bus: SlingshotEventBus,
  config: MailPluginConfig,
  queue: MailQueue,
): Array<() => void> {
  const unsubscribers: Array<() => void> = [];
  const enqueueTimeoutMs =
    config.subscriptionEnqueueTimeoutMs ?? DEFAULT_SUBSCRIPTION_ENQUEUE_TIMEOUT_MS;

  for (const sub of config.subscriptions ?? []) {
    // Capture sub in closure to avoid loop variable capture issues
    const subscription = sub;
    const subscriptionId = resolveSubscriptionId(subscription);

    const handler = async (
      payload: SlingshotEventMap[typeof subscription.event],
      eventId?: string,
    ) => {
      try {
        const data = subscription.dataMapper
          ? subscription.dataMapper(payload)
          : (payload as Record<string, unknown>);

        const recipient = subscription.recipientMapper
          ? subscription.recipientMapper(payload)
          : (payload as Record<string, unknown>)['email'];

        if (!recipient) {
          console.error(`[slingshot-mail] No recipient for event ${subscription.event}`);
          await notifySubscriptionDrop(config, {
            event: subscription.event,
            template: subscription.template,
            reason: 'missing-recipient',
            payload,
          });
          return;
        }

        const rendered = await config.renderer.render(subscription.template, data);
        const subject = resolveAndInterpolateSubject(subscription.subject, rendered.subject, data);

        const message: MailMessage = {
          from: config.from,
          to: recipient as MailAddress,
          subject,
          html: rendered.html,
          text: rendered.text,
          replyTo: config.replyTo,
          tags: subscription.tags,
        };

        // Derive an idempotency key from the envelope's eventId (when available) and
        // the stable subscription id so retried bus deliveries deduplicate at the
        // queue layer instead of producing duplicate mail.
        const idempotencyKey = eventId !== undefined ? `${eventId}:${subscriptionId}` : undefined;

        try {
          await enqueueWithTimeout(
            queue.enqueue(message, {
              sourceEvent: subscription.event,
              idempotencyKey,
            }),
            enqueueTimeoutMs,
            subscription.event,
          );
        } catch (err) {
          console.error(`[slingshot-mail] Failed to enqueue event ${subscription.event}:`, err);
          await notifySubscriptionDrop(config, {
            event: subscription.event,
            template: subscription.template,
            reason:
              err instanceof Error && err.message.includes('timed out')
                ? 'enqueue-timeout'
                : 'enqueue-error',
            payload,
            error: err instanceof Error ? err : new Error(String(err)),
          });
          return;
        }
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          console.error(
            `[slingshot-mail] Template not found for event ${subscription.event}: ${err.templateName}`,
          );
          await notifySubscriptionDrop(config, {
            event: subscription.event,
            template: subscription.template,
            reason: 'template-not-found',
            payload,
            error: err,
          });
        } else {
          console.error(`[slingshot-mail] Error processing event ${subscription.event}:`, err);
          await notifySubscriptionDrop(config, {
            event: subscription.event,
            template: subscription.template,
            reason: 'handler-error',
            payload,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    };

    const busOnOpts = config.durableSubscriptions
      ? {
          durable: true as const,
          name: `slingshot-mail:${subscription.event}:${subscription.template}`,
        }
      : undefined;

    // Prefer onEnvelope so we can read meta.eventId and derive a stable idempotency
    // key. Fall back to on() for legacy bus implementations that don't expose the
    // envelope API — those callers simply lose auto-derived idempotency.
    if (typeof bus.onEnvelope === 'function') {
      const envelopeListener = (
        envelope: EventEnvelope<typeof subscription.event>,
      ): void | Promise<void> =>
        handler(
          envelope.payload as SlingshotEventMap[typeof subscription.event],
          envelope.meta.eventId,
        );
      bus.onEnvelope(subscription.event, envelopeListener, busOnOpts);
      unsubscribers.push(() => bus.offEnvelope(subscription.event, envelopeListener));
    } else {
      const payloadListener = (
        payload: SlingshotEventMap[typeof subscription.event],
      ): void | Promise<void> => handler(payload);
      bus.on(subscription.event, payloadListener, busOnOpts);
      unsubscribers.push(() => bus.off(subscription.event, payloadListener));
    }
  }

  return unsubscribers;
}

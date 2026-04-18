import type { SlingshotEventBus, SlingshotEventMap } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import type { MailPluginConfig } from '../types/config';
import type { MailAddress, MailMessage } from '../types/provider';
import type { MailQueue } from '../types/queue';
import { resolveAndInterpolateSubject } from './subjectResolution';

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

  for (const sub of config.subscriptions ?? []) {
    // Capture sub in closure to avoid loop variable capture issues
    const subscription = sub;

    const handler = async (payload: SlingshotEventMap[typeof subscription.event]) => {
      try {
        const data = subscription.dataMapper
          ? subscription.dataMapper(payload)
          : (payload as Record<string, unknown>);

        const recipient = subscription.recipientMapper
          ? subscription.recipientMapper(payload)
          : (payload as Record<string, unknown>)['email'];

        if (!recipient) {
          console.error(`[slingshot-mail] No recipient for event ${subscription.event}`);
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

        await queue.enqueue(message, { sourceEvent: subscription.event });
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          console.error(
            `[slingshot-mail] Template not found for event ${subscription.event}: ${err.templateName}`,
          );
        } else {
          console.error(`[slingshot-mail] Error processing event ${subscription.event}:`, err);
        }
      }
    };

    const busOnOpts = config.durableSubscriptions
      ? {
          durable: true as const,
          name: `slingshot-mail:${subscription.event}:${subscription.template}`,
        }
      : undefined;

    bus.on(
      subscription.event,
      handler as (payload: SlingshotEventMap[typeof subscription.event]) => void | Promise<void>,
      busOnOpts,
    );
    unsubscribers.push(() =>
      bus.off(
        subscription.event,
        handler as (payload: SlingshotEventMap[typeof subscription.event]) => void,
      ),
    );
  }

  return unsubscribers;
}

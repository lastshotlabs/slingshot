import type {
  DynamicEventBus,
  Logger,
  MetricsEmitter,
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  createNoopMetricsEmitter,
  getContextOrNull,
  validateAdapterShape,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { validateSubscriptionTemplates, wireSubscriptions } from './lib/subscriptionWiring';
import { fanOutBounce, parseResendWebhook, parseSesWebhook } from './lib/webhookHandlers';
import { createMemoryQueue } from './queues/memory';
import type { MailPluginConfig } from './types/config';
import { mailPluginConfigSchema } from './types/config';
import type { MailQueue } from './types/queue';

/**
 * Creates the slingshot-mail plugin for event-driven transactional email delivery.
 *
 * Validates the config and adapter shapes at construction time (fail-fast). Mail delivery
 * is entirely event-driven — subscribe to `SlingshotEventMap` keys via `config.subscriptions`
 * and the plugin dispatches templated emails automatically when those events fire.
 *
 * @param rawConfig - Plugin configuration including provider, renderer, subscriptions, and queue.
 *   When `rawConfig.queue` is omitted, the plugin automatically creates an in-memory queue
 *   via `createMemoryQueue({ maxAttempts, onDeadLetter })` using the values from
 *   `rawConfig.queueConfig` and `rawConfig.onDeadLetter`. The in-memory queue does not
 *   survive process restarts; provide a persistent `MailQueue` implementation for production use.
 * @returns A `SlingshotPlugin` instance ready to be passed to `createServer`.
 * @throws {Error} If `config.provider` or `config.renderer` are missing or have the wrong shape.
 *
 * @example
 * ```ts
 * import { createMailPlugin, createResendProvider, createRawHtmlRenderer } from '@lastshotlabs/slingshot-mail';
 *
 * const mailPlugin = createMailPlugin({
 *   provider: createResendProvider({ apiKey: process.env.RESEND_KEY! }),
 *   renderer: createRawHtmlRenderer({
 *     templates: {
 *       'welcome': { subject: 'Welcome!', html: '<p>Hello {{name}}</p>' },
 *     },
 *   }),
 *   from: 'noreply@example.com',
 *   subscriptions: [
 *     {
 *       event: 'auth:user.created',
 *       template: 'welcome',
 *       recipientMapper: payload => payload.email,
 *       dataMapper: payload => ({ name: payload.email }),
 *     },
 *   ],
 * });
 * ```
 */
export function createMailPlugin(rawConfig: MailPluginConfig): SlingshotPlugin {
  const config = validatePluginConfig('slingshot-mail', rawConfig, mailPluginConfigSchema);

  validateAdapterShape('slingshot-mail', 'provider', config.provider, ['send']);
  validateAdapterShape('slingshot-mail', 'renderer', config.renderer, ['render']);

  let queue: MailQueue | null = null;
  let unsubscribers: Array<() => void> = [];
  let activated = false;
  let busRef: DynamicEventBus | null = null;
  const logger: Logger = createConsoleLogger({ base: { plugin: 'slingshot-mail' } });

  // Lazy metrics resolution — the framework-owned emitter is not available
  // until setupPost runs, but the in-memory queue is constructed at that
  // moment too, so we pass the proxy through `config.metrics` and have it
  // forward to whatever the plugin resolves from the app context.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  async function activate(bus: SlingshotEventBus, app: unknown): Promise<void> {
    if (activated) {
      throw new Error(
        '[slingshot-mail] createMailPlugin: already activated — do not call setupPost() more than once',
      );
    }
    activated = true;
    busRef = bus as unknown as DynamicEventBus;

    // Resolve the framework-owned metrics emitter so the queue (and any
    // user-supplied queue that observed config.metrics) publishes mail
    // counters/gauges/timings on hot paths.
    if (app !== null && app !== undefined) {
      const ctx = getContextOrNull(app as Parameters<typeof getContextOrNull>[0]);
      if (ctx?.metricsEmitter) resolvedMetricsEmitter = ctx.metricsEmitter;
    }

    // 1. Resolve queue
    const providedQueue = config.queue ?? null;
    queue =
      providedQueue ??
      createMemoryQueue({
        maxAttempts: config.queueConfig?.maxAttempts,
        onDeadLetter: config.onDeadLetter,
        drainTimeoutMs: config.queueConfig?.drainTimeoutMs,
        sendTimeoutMs: config.queueConfig?.sendTimeoutMs,
        maxEntries: config.queueConfig?.maxEntries,
        metrics: metricsProxy,
        bus: bus as unknown as DynamicEventBus,
      });

    if (config.durableSubscriptions && queue.name === 'memory') {
      throw new Error(
        '[slingshot-mail] durableSubscriptions: true requires a durable queue (e.g. BullMQ). ' +
          'The memory queue does not support durable subscriptions.',
      );
    }

    try {
      // 2. Start queue (throws immediately if backend is unavailable)
      await queue.start(config.provider);

      // 3. Validate templates on startup if enabled (default: true when renderer supports it).
      // Throws MailTemplateNotFoundError so callers fail fast instead of discovering missing
      // templates only when the corresponding event fires at runtime.
      if (config.validateTemplatesOnStartup !== false) {
        await validateSubscriptionTemplates(config);
      }

      // 4. Optional provider health check. `failOnHealthCheck` defaults to
      // 'error' so a misconfigured provider aborts boot rather than silently
      // accepting traffic. Set to 'warn' to keep the historical permissive
      // behaviour (e.g. for ephemeral test environments).
      if (config.provider.healthCheck) {
        try {
          await config.provider.healthCheck();
        } catch (err) {
          const mode = config.failOnHealthCheck ?? 'error';
          const message = err instanceof Error ? err.message : String(err);
          if (mode === 'error') {
            throw new Error(`[slingshot-mail] Provider health check failed: ${message}`, {
              cause: err,
            });
          }
          logger.warn('provider health check failed', { err: message });
        }
      }

      // 5. Wire subscriptions
      unsubscribers = wireSubscriptions(bus, config, queue);
    } catch (err) {
      unsubscribers = [];
      activated = false;
      if (queue) {
        try {
          await queue.stop();
        } catch {
          // Best-effort cleanup for partially initialized queues.
        }
      }
      if (!providedQueue) {
        queue = null;
      }
      throw err;
    }
  }

  return {
    name: 'slingshot-mail',
    dependencies: [],

    /**
     * Mount the optional bounce/complaint webhook route. Apps wire their
     * mail provider's webhook delivery URL to this endpoint so the plugin
     * can surface bounces and complaints on the bus and through the
     * `markEmailUnsubscribed` callback.
     */
    setupRoutes({ app }: PluginSetupContext): void {
      const route = config.webhookRoute ?? '/mail/webhook';
      if (route === '') return;
      app.post(`${route}/:provider`, async c => {
        const provider = c.req.param('provider');
        if (provider !== 'resend' && provider !== 'ses') {
          return c.json({ ok: false, error: 'unsupported provider' }, 400);
        }
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: 'invalid json' }, 400);
        }
        // SES delivers webhooks via SNS. The first request after wiring the
        // topic is a `SubscriptionConfirmation` — surface it for operators.
        if (provider === 'ses' && isObject(body) && body.Type === 'SubscriptionConfirmation') {
          logger.warn('SES webhook subscription confirmation received', {
            subscribeURL: typeof body.SubscribeURL === 'string' ? body.SubscribeURL : undefined,
          });
          return c.json({ ok: true, action: 'confirm-required' });
        }
        const records = provider === 'resend' ? parseResendWebhook(body) : parseSesWebhook(body);
        if (!busRef) {
          // Without an active bus we still want a 2xx so the provider stops
          // retrying. Operators see the warning in logs.
          logger.warn('webhook received before plugin activation', { provider });
          return c.json({ ok: true, processed: 0 });
        }
        for (const rec of records) {
          await fanOutBounce(rec, busRef, config.markEmailUnsubscribed, logger);
        }
        return c.json({ ok: true, processed: records.length });
      });
    },

    /**
     * Post-assembly phase — used when running inside the Slingshot framework.
     * Mail doesn't need routes or middleware; it only needs the event bus.
     */
    async setupPost({ app, bus }: PluginSetupContext): Promise<void> {
      await activate(bus, app);
    },

    async teardown(): Promise<void> {
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch (err) {
          logger.error('failed to remove event subscription during teardown', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      unsubscribers = [];
      if (queue) {
        // Drain pending mails up to the configured timeout so graceful
        // shutdown does not silently lose in-flight traffic. Drain emits
        // `mail:drain.timedOut` if the deadline elapses.
        try {
          if (typeof queue.drain === 'function') await queue.drain();
        } catch (err) {
          logger.warn('drain raised during teardown', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        await queue.stop();
        queue = null;
      }
      busRef = null;
      activated = false;
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

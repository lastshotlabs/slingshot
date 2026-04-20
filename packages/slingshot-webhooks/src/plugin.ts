import type { MiddlewareHandler } from 'hono';
import type {
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { deliverWebhook } from './lib/dispatcher';
import { wireEventSubscriptions } from './lib/eventWiring';
import { createWebhookMemoryQueue } from './queues/memory';
import { createInboundRouter } from './routes/inbound';
import { WEBHOOK_ROUTES } from './routes/index';
import type { WebhookAdapter } from './types/adapter';
import type { WebhookPluginConfig } from './types/config';
import { webhookPluginConfigSchema } from './types/config';
import type { InboundProvider } from './types/inbound';
import { WEBHOOKS_PLUGIN_STATE_KEY } from './types/public';
import type { WebhookJob, WebhookQueue } from './types/queue';
import { WebhookDeliveryError } from './types/queue';

function buildRoleGuard(role: string): MiddlewareHandler {
  return async (c, next) => {
    const roles = c.get('roles') as string[] | null | undefined;
    if (!roles || !roles.includes(role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}

function buildInboundPublicPaths(
  mountPath: string,
  inbound: readonly InboundProvider[] | undefined,
  disableRoutes: readonly string[] | undefined,
): string[] {
  if (!inbound || inbound.length === 0) {
    return [];
  }
  if (disableRoutes?.includes(WEBHOOK_ROUTES.INBOUND)) {
    return [];
  }
  return [`${mountPath}/inbound/*`];
}

async function activate(
  bus: SlingshotEventBus,
  config: Readonly<WebhookPluginConfig>,
  queue: WebhookQueue,
  runtime: WebhookAdapter,
): Promise<Array<() => void>> {
  const maxAttempts = config.queueConfig?.maxAttempts ?? 5;
  const baseDelay = config.queueConfig?.retryBaseDelayMs ?? 1000;

  const processor = async (job: WebhookJob): Promise<void> => {
    if (job.attempts > 0) {
      await runtime.updateDelivery(job.deliveryId, {
        status: 'pending',
        nextRetryAt: null,
      });
    }

    const attemptedAt = new Date().toISOString();
    const start = Date.now();
    try {
      await deliverWebhook(job);
      const durationMs = Date.now() - start;
      await runtime.updateDelivery(job.deliveryId, {
        status: 'delivered',
        attempts: job.attempts + 1,
        nextRetryAt: null,
        lastAttempt: { attemptedAt, durationMs },
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const retryable = err instanceof WebhookDeliveryError ? err.retryable : true;
      const code = err instanceof WebhookDeliveryError ? err.statusCode : undefined;
      const isLast = !retryable || job.attempts + 1 >= maxAttempts;
      await runtime.updateDelivery(job.deliveryId, {
        status: isLast ? 'dead' : 'failed',
        attempts: job.attempts + 1,
        nextRetryAt: isLast
          ? null
          : new Date(Date.now() + baseDelay * Math.pow(2, job.attempts)).toISOString(),
        lastAttempt: {
          attemptedAt,
          statusCode: code,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  };

  await queue.start(processor);
  return wireEventSubscriptions(bus, config, queue, runtime);
}

async function resolveTestDelivery(
  runtime: WebhookAdapter,
  queue: WebhookQueue,
  config: Readonly<WebhookPluginConfig>,
  endpointId: string,
): Promise<{ deliveryId: string }> {
  const endpoint = await runtime.getEndpoint(endpointId);
  if (!endpoint) {
    throw new Error('Not found');
  }

  const payload = JSON.stringify({
    test: true,
    endpointId,
    timestamp: new Date().toISOString(),
  });
  const delivery = await runtime.createDelivery({
    endpointId,
    event: 'webhook:test',
    payload,
    maxAttempts: config.queueConfig?.maxAttempts ?? 5,
  });

  try {
    await queue.enqueue({
      deliveryId: delivery.id,
      endpointId,
      url: endpoint.url,
      secret: endpoint.secret,
      event: 'webhook:test',
      payload,
      attempts: 0,
    });
  } catch (err) {
    await runtime.updateDelivery(delivery.id, {
      status: 'dead',
      lastAttempt: {
        attemptedAt: new Date().toISOString(),
        error: 'enqueue failed: ' + String(err),
      },
    });
    throw err;
  }

  return { deliveryId: delivery.id };
}

/**
 * Creates the manifest-driven webhook plugin for outbound delivery and inbound reception.
 */
export function createWebhookPlugin(rawConfig: WebhookPluginConfig): SlingshotPlugin {
  const config = deepFreeze(
    validatePluginConfig(WEBHOOKS_PLUGIN_STATE_KEY, rawConfig, webhookPluginConfigSchema),
  );
  const queue: WebhookQueue =
    config.queue === 'memory' || !config.queue
      ? createWebhookMemoryQueue({
          maxAttempts: config.queueConfig?.maxAttempts,
        })
      : config.queue;
  const mountPath = config.mountPath ?? '/webhooks';
  const managementRole = config.managementRole ?? 'admin';
  const requireWebhookAdmin = buildRoleGuard(managementRole);
  const inboundRoutePatterns = buildInboundPublicPaths(
    mountPath,
    config.inbound,
    config.disableRoutes,
  );
  let unsubscribers: Array<() => void> = [];
  let innerPlugin: SlingshotPlugin | undefined;
  let runtimeAdapter: WebhookAdapter | undefined;

  return {
    name: WEBHOOKS_PLUGIN_STATE_KEY,
    dependencies: config.adapter ? [] : ['slingshot-auth'],
    publicPaths: inboundRoutePatterns,
    csrfExemptPaths: inboundRoutePatterns,

    async setupMiddleware({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      if (config.adapter) {
        runtimeAdapter = config.adapter;
      } else {
        const { createEntityPlugin } = await import('@lastshotlabs/slingshot-entity');
        const { createWebhooksManifestRuntime } = await import('./manifest/runtime');
        const { webhooksManifest } = await import('./manifest/webhooksManifest');
        innerPlugin = createEntityPlugin({
          name: WEBHOOKS_PLUGIN_STATE_KEY,
          mountPath,
          manifest: webhooksManifest,
          manifestRuntime: createWebhooksManifestRuntime(adapter => {
            runtimeAdapter = adapter;
          }),
          middleware: {
            webhooksAdminGuard: requireWebhookAdmin,
          },
        });
        await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus });
      }
    },

    async setupRoutes({ app, bus, config: frameworkConfig }: PluginSetupContext): Promise<void> {
      const disabled = new Set(config.disableRoutes ?? []);

      if (!disabled.has(WEBHOOK_ROUTES.ENDPOINTS)) {
        await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus });

        app.post(`${mountPath}/endpoints/:id/test`, requireWebhookAdmin, async c => {
          const adapter = runtimeAdapter;
          if (!adapter) {
            return c.json({ error: 'Webhook runtime is not ready' }, 500);
          }
          const endpointId = c.req.param('id');
          try {
            const result = await resolveTestDelivery(adapter, queue, config, endpointId);
            return c.json(result, 200);
          } catch (err) {
            if (err instanceof Error && err.message === 'Not found') {
              return c.json({ error: 'Not found' }, 404);
            }
            return c.json({ error: 'Failed to enqueue test delivery' }, 500);
          }
        });
      }

      if ((config.inbound?.length ?? 0) > 0 && !disabled.has(WEBHOOK_ROUTES.INBOUND)) {
        app.route(`${mountPath}/inbound`, createInboundRouter([...(config.inbound ?? [])], bus));
      }
    },

    async setupPost({ bus, config: frameworkConfig, app }: PluginSetupContext): Promise<void> {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus });
      if (!runtimeAdapter) {
        throw new Error('[slingshot-webhooks] Manifest adapters were not resolved during setup');
      }
      getPluginState(app).set(WEBHOOKS_PLUGIN_STATE_KEY, runtimeAdapter);
      unsubscribers = await activate(bus, config, queue, runtimeAdapter);
    },

    async teardown(): Promise<void> {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers = [];
      await queue.stop();
      await innerPlugin?.teardown?.();
    },
  };
}

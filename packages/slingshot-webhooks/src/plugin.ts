import type { MiddlewareHandler } from 'hono';
import type {
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getPluginState,
  getRouteAuth,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { deliverWebhook } from './lib/dispatcher';
import { wireEventSubscriptions } from './lib/eventWiring';
import { createWebhooksManifestRuntime } from './manifest/runtime';
import type { WebhookRuntimeAdapter } from './manifest/runtime';
import { webhooksManifest } from './manifest/webhooksManifest';
import { createWebhookMemoryQueue } from './queues/memory';
import { createInboundRouter } from './routes/inbound';
import { WEBHOOK_ROUTES } from './routes/index';
import type { WebhookPluginConfig } from './types/config';
import { webhookPluginConfigSchema } from './types/config';
import type { InboundProvider } from './types/inbound';
import type { WebhookJob, WebhookQueue } from './types/queue';
import { WebhookDeliveryError } from './types/queue';

async function runGuardMiddleware(
  middleware: MiddlewareHandler,
  c: Parameters<MiddlewareHandler>[0],
): Promise<Response | null> {
  let nextCalled = false;
  const result = await middleware(c, async () => {
    nextCalled = true;
  });
  if (nextCalled) {
    return null;
  }
  return result instanceof Response ? result : c.res;
}

function buildAdminMiddleware(role: string): MiddlewareHandler {
  return async (c, next) => {
    const slingshotCtx = c.get('slingshotCtx') as Parameters<typeof getRouteAuth>[0] | undefined;
    if (!slingshotCtx) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const routeAuth = getRouteAuth(slingshotCtx);
    const authFailure = await runGuardMiddleware(routeAuth.userAuth, c);
    if (authFailure) {
      return authFailure;
    }
    const roleFailure = await runGuardMiddleware(routeAuth.requireRole(role), c);
    if (roleFailure) {
      return roleFailure;
    }
    await next();
  };
}

function buildInboundPublicPaths(
  mountPath: string,
  inbound: readonly InboundProvider[] | undefined,
): string[] {
  if (!inbound || inbound.length === 0) {
    return [];
  }
  return [`${mountPath}/inbound/*`];
}

async function activate(
  bus: SlingshotEventBus,
  config: Readonly<WebhookPluginConfig>,
  queue: WebhookQueue,
  runtime: WebhookRuntimeAdapter,
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
  runtime: WebhookRuntimeAdapter,
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
    validatePluginConfig('slingshot-webhooks', rawConfig, webhookPluginConfigSchema),
  );
  const queue: WebhookQueue =
    config.queue === 'memory' || !config.queue
      ? createWebhookMemoryQueue({
          maxAttempts: config.queueConfig?.maxAttempts,
        })
      : config.queue;
  const mountPath = config.mountPath ?? '/webhooks';
  const managementRole = config.managementRole ?? 'admin';
  const requireWebhookAdmin = buildAdminMiddleware(managementRole);
  let unsubscribers: Array<() => void> = [];
  let innerPlugin: EntityPlugin | undefined;
  let runtimeAdapter: WebhookRuntimeAdapter | undefined;

  return {
    name: 'slingshot-webhooks',
    dependencies: ['slingshot-auth'],
    publicPaths: buildInboundPublicPaths(mountPath, config.inbound),
    csrfExemptPaths: [`${mountPath}/inbound/*`],

    async setupMiddleware({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      innerPlugin = createEntityPlugin({
        name: 'slingshot-webhooks',
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
      getPluginState(app).set('slingshot-webhooks', runtimeAdapter);
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

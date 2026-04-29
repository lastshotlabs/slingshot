import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  MetricsEmitter,
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  HeaderInjectionError,
  SafeFetchBlockedError,
  SafeFetchDnsError,
  createNoopMetricsEmitter,
  deepFreeze,
  getActor,
  getContextOrNull,
  getPluginState,
  getRouteAuthOrNull,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { deliverWebhook } from './lib/dispatcher';
import { wireEventSubscriptions } from './lib/eventWiring';
import { logWebhookEvent } from './lib/log';
import type { GovernedWebhookRuntime } from './manifest/runtime';
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

/**
 * Path-param validator for webhook endpoint IDs.
 *
 * Endpoint IDs are persisted entity ids (UUIDs by default) — we keep the
 * character set conservative but accept any non-UUID value within bounds so
 * adapters that mint custom ids continue to work; oversized or empty inputs
 * are rejected before they reach the adapter layer.
 */
const endpointIdParamSchema = z
  .string()
  .min(1, 'endpoint id is required')
  .max(128, 'endpoint id must be at most 128 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'endpoint id contains invalid characters');

/**
 * Runs a Hono middleware and returns its response if it blocked (did not call
 * `next()`), or `null` if it passed through.
 */
async function runGuardMiddleware(
  middleware: MiddlewareHandler,
  c: Parameters<MiddlewareHandler>[0],
): Promise<Response | null> {
  let nextCalled = false;
  const result = await middleware(c, async () => {
    nextCalled = true;
  });
  if (nextCalled) return null;
  return result instanceof Response ? result : c.res;
}

/**
 * Builds an admin guard middleware that resolves and checks the required role.
 *
 * When the full framework context is available (auth plugin registered), it
 * delegates to `routeAuth.requireRole()` which resolves effective roles from the
 * adapter (respecting tenant scoping). When running standalone (no auth plugin),
 * it falls back to reading `getActor(c).roles` directly — the host app is
 * responsible for populating the actor on the context.
 */
function buildRoleGuard(role: string): MiddlewareHandler {
  return async (c, next) => {
    const slingshotCtx = c.get('slingshotCtx') as
      | Parameters<typeof getRouteAuthOrNull>[0]
      | undefined;
    if (slingshotCtx) {
      const routeAuth = getRouteAuthOrNull(slingshotCtx);
      if (routeAuth) {
        const blocked = await runGuardMiddleware(routeAuth.requireRole(role), c);
        if (blocked) return blocked;
        return next();
      }
    }
    // Standalone: roles from actor context
    const roles = getActor(c).roles;
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

function classifyDeliveryFailure(err: unknown): string {
  if (err instanceof HeaderInjectionError) return 'injection';
  if (err instanceof SafeFetchBlockedError) return 'sslError';
  if (err instanceof SafeFetchDnsError) return 'dnsError';
  if (err instanceof WebhookDeliveryError) {
    // Header-injection failures are surfaced as WebhookDeliveryError by the
    // dispatcher when sanitizeHeaderValue rejects. Detect via message prefix
    // since the inner error type was already mapped.
    if (err.message.startsWith('Webhook delivery aborted: header')) return 'injection';
    if (err.message.startsWith('Webhook delivery blocked')) return 'sslError';
    if (err.message.startsWith('Webhook DNS lookup failed')) return 'dnsError';
    if (err.message.startsWith('Webhook delivery aborted: signing')) return 'signError';
  }
  if (err instanceof Error && /timed out/i.test(err.message)) return 'timeout';
  return 'failure';
}

async function activate(
  bus: SlingshotEventBus,
  events: PluginSetupContext['events'],
  config: Readonly<WebhookPluginConfig>,
  queue: WebhookQueue,
  runtime: WebhookAdapter,
  metrics: MetricsEmitter,
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
    const dispatchStart = performance.now();
    try {
      // Resolution order: per-endpoint override (job.deliveryTimeoutMs) >
      // plugin-wide default (config.deliveryTimeoutMs) > 30s baseline.
      const requestedTimeoutMs = job.deliveryTimeoutMs ?? config.deliveryTimeoutMs ?? 30_000;
      // P-WEBHOOKS-9: warn loudly when a caller-requested timeout exceeds
      // the 120s clamp so operators can see the bypass instead of having
      // the value silently downgraded.
      const TIMEOUT_CLAMP_MS = 120_000;
      let resolvedTimeoutMs = requestedTimeoutMs;
      if (requestedTimeoutMs > TIMEOUT_CLAMP_MS) {
        resolvedTimeoutMs = TIMEOUT_CLAMP_MS;
        logWebhookEvent('warn', 'webhook timeout clamped', {
          deliveryId: job.deliveryId,
          endpointId: job.endpointId,
          requestedTimeoutMs,
          clampedTimeoutMs: TIMEOUT_CLAMP_MS,
        });
        try {
          (bus as { emit(event: string, payload: unknown): void }).emit(
            'webhook:timeoutClamped',
            {
              deliveryId: job.deliveryId,
              endpointId: job.endpointId,
              requestedTimeoutMs,
              clampedTimeoutMs: TIMEOUT_CLAMP_MS,
            },
          );
        } catch {
          // bus emission must never break delivery
        }
      }
      await deliverWebhook(job, {
        timeoutMs: resolvedTimeoutMs,
      });
      const durationMs = Date.now() - start;
      // Cardinality discipline: timing has no labels — endpointId would
      // explode the series count. Use an aggregate timing for dispatch
      // duration and rely on result-labelled counters for breakdowns.
      metrics.timing('webhooks.delivery.duration', performance.now() - dispatchStart);
      metrics.counter('webhooks.delivery.count', 1, { result: 'success' });
      await runtime.updateDelivery(job.deliveryId, {
        status: 'delivered',
        attempts: job.attempts + 1,
        nextRetryAt: null,
        lastAttempt: { attemptedAt, durationMs },
      });
      logWebhookEvent('info', 'webhook delivered', {
        deliveryId: job.deliveryId,
        endpointId: job.endpointId,
        event: String(job.event),
        attempt: job.attempts + 1,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const retryable = err instanceof WebhookDeliveryError ? err.retryable : true;
      const code = err instanceof WebhookDeliveryError ? err.statusCode : undefined;
      const isLast = !retryable || job.attempts + 1 >= maxAttempts;
      const result = classifyDeliveryFailure(err);
      metrics.timing('webhooks.delivery.duration', performance.now() - dispatchStart);
      metrics.counter('webhooks.delivery.count', 1, { result });
      if (isLast) {
        metrics.counter('webhooks.dlq.count');
      }
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
      logWebhookEvent(isLast ? 'error' : 'warn', 'webhook delivery failed', {
        deliveryId: job.deliveryId,
        endpointId: job.endpointId,
        event: String(job.event),
        attempt: job.attempts + 1,
        durationMs,
        statusCode: code,
        retryable,
        terminal: isLast,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      // Sample queue depth on every job completion. Best-effort observability:
      // a depth read failure must never propagate as a delivery failure.
      if (typeof queue.depth === 'function') {
        try {
          const depth = await queue.depth();
          metrics.gauge('webhooks.queue.depth', depth);
        } catch {
          // ignore — observability is best-effort.
        }
      }
    }
  };

  await queue.start(processor);
  return wireEventSubscriptions(bus, events, config, queue, runtime);
}

/**
 * P-WEBHOOKS-7: synchronous test-delivery driver. Sends a synthetic event
 * directly through the dispatcher (no queue) and returns the upstream
 * response status + body so admins see the endpoint's actual answer.
 */
async function runTestDelivery(
  runtime: WebhookAdapter,
  endpointId: string,
  config: Readonly<WebhookPluginConfig>,
): Promise<{ status: number; ok: boolean; body: string; durationMs: number }> {
  const endpoint = await runtime.getEndpoint(endpointId);
  if (!endpoint) {
    throw new Error('Not found');
  }
  const eventId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const payload = JSON.stringify({
    test: true,
    endpointId,
    timestamp: occurredAt,
  });
  const deliveryTimeoutMs =
    endpoint.deliveryTimeoutMs ?? config.deliveryTimeoutMs ?? 30_000;
  const start = Date.now();
  let status = 0;
  let body = '';
  let ok = false;
  await deliverWebhook(
    {
      deliveryId: 'test-' + eventId,
      endpointId,
      url: endpoint.url,
      secret: endpoint.secret,
      event: 'webhook:test' as never,
      eventId,
      occurredAt,
      subscriber: {
        ownerType: endpoint.ownerType,
        ownerId: endpoint.ownerId,
        tenantId: endpoint.tenantId ?? null,
      },
      payload,
      attempts: 0,
    },
    {
      timeoutMs: deliveryTimeoutMs,
      // Add the test marker to outbound headers via a fetch interceptor:
      // tag the synthetic delivery so receivers can branch on header alone.
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? {});
        headers.set('X-Webhook-Test', 'true');
        const res = await fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
        status = res.status;
        ok = res.ok;
        body = await res.text().catch(() => '');
        // Return a clone so deliverWebhook can read the body if needed.
        return new Response(body, { status, headers: res.headers });
      },
    },
  ).catch(err => {
    // deliverWebhook throws on non-2xx; we still want to return whatever
    // status / body the upstream produced, not "Test delivery failed".
    if (status > 0) return; // we have a real upstream answer
    throw err;
  });
  return { status, ok, body: body.slice(0, 4096), durationMs: Date.now() - start };
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
  const occurredAt = new Date().toISOString();
  const delivery = await runtime.createDelivery({
    endpointId,
    event: 'webhook:test' as never,
    eventId: crypto.randomUUID(),
    occurredAt,
    subscriber: {
      ownerType: endpoint.ownerType,
      ownerId: endpoint.ownerId,
      tenantId: endpoint.tenantId ?? null,
    },
    sourceScope:
      endpoint.tenantId === undefined || endpoint.tenantId === null
        ? null
        : { tenantId: endpoint.tenantId },
    payload,
    maxAttempts: config.queueConfig?.maxAttempts ?? 5,
  });

  try {
    await queue.enqueue({
      deliveryId: delivery.id,
      endpointId,
      url: endpoint.url,
      secret: endpoint.secret,
      event: 'webhook:test' as never,
      eventId: delivery.eventId,
      occurredAt,
      subscriber: delivery.subscriber,
      payload,
      attempts: 0,
      deliveryTimeoutMs: endpoint.deliveryTimeoutMs ?? null,
    });
  } catch (err) {
    // P-WEBHOOKS-8: enqueue failure is not a permanent delivery failure.
    // Leave the delivery `pending` and surface the enqueue error to the
    // caller so they can retry; do NOT mark the row `dead` and silently
    // discard the work.
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

  // Lazy metrics resolution — proxied so the dispatcher pipeline picks up the
  // framework-owned emitter the moment setupPost runs.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  return {
    name: WEBHOOKS_PLUGIN_STATE_KEY,
    dependencies: config.adapter ? [] : ['slingshot-auth'],
    publicPaths: inboundRoutePatterns,
    csrfExemptPaths: inboundRoutePatterns,

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      if (config.adapter) {
        runtimeAdapter = config.adapter;
      } else {
        if (!config.secretEncryptionKey && !config.encryptor) {
          if (process.env.NODE_ENV === 'production' && !config.allowPlaintextSecrets) {
            throw new Error(
              '[slingshot-webhooks] secret encryption is required in production. ' +
                'Set secretEncryptionKey, supply a custom encryptor, or explicitly set ' +
                'allowPlaintextSecrets: true if storage encryption is handled externally.',
            );
          }
          console.warn(
            '[slingshot-webhooks] no secret encryption is configured. Endpoint secrets ' +
              'will be stored as plaintext. Set secretEncryptionKey to a base64 32-byte AES key, ' +
              'or supply a custom `encryptor`, before exposing this app to production traffic.',
          );
        }
        const { createEntityPlugin } = await import('@lastshotlabs/slingshot-entity');
        const { createWebhooksManifestRuntime } = await import('./manifest/runtime');
        const { webhooksManifest } = await import('./manifest/webhooksManifest');
        innerPlugin = createEntityPlugin({
          name: WEBHOOKS_PLUGIN_STATE_KEY,
          mountPath,
          manifest: webhooksManifest,
          manifestRuntime: createWebhooksManifestRuntime(
            adapter => {
              runtimeAdapter = adapter;
            },
            {
              secretEncryptionKey: config.secretEncryptionKey ?? null,
              encryptor: config.encryptor ?? null,
            },
          ),
          middleware: {
            webhooksAdminGuard: requireWebhookAdmin,
          },
        });
        await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus, events });
      }
    },

    async setupRoutes({
      app,
      bus,
      config: frameworkConfig,
      events,
    }: PluginSetupContext): Promise<void> {
      const disabled = new Set(config.disableRoutes ?? []);

      if (!disabled.has(WEBHOOK_ROUTES.ENDPOINTS)) {
        await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

        app.post(`${mountPath}/endpoints/:id/test`, requireWebhookAdmin, async c => {
          const adapter = runtimeAdapter;
          if (!adapter) {
            return c.json({ error: 'Webhook runtime is not ready' }, 500);
          }
          const endpointIdResult = endpointIdParamSchema.safeParse(c.req.param('id'));
          if (!endpointIdResult.success) {
            return c.json(
              {
                error: 'INVALID_PARAM',
                message: endpointIdResult.error.issues[0]?.message ?? 'invalid endpoint id',
              },
              400,
            );
          }
          const endpointId = endpointIdResult.data;
          // P-WEBHOOKS-7: send a synthetic event synchronously to the
          // endpoint and return the upstream response status + body. Bypass
          // the queue so callers see the upstream answer immediately;
          // enqueueing for retry is a separate workflow.
          try {
            const result = await runTestDelivery(adapter, endpointId, config);
            return c.json(result, 200);
          } catch (err) {
            if (err instanceof Error && err.message === 'Not found') {
              return c.json({ error: 'Not found' }, 404);
            }
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'Test delivery failed', message }, 502);
          }
        });
      }

      if ((config.inbound?.length ?? 0) > 0 && !disabled.has(WEBHOOK_ROUTES.INBOUND)) {
        app.route(
          `${mountPath}/inbound`,
          createInboundRouter([...(config.inbound ?? [])], bus, {
            maxBodyBytes: config.inboundMaxBodyBytes,
          }),
        );
      }
    },

    async setupPost({
      bus,
      config: frameworkConfig,
      app,
      events,
    }: PluginSetupContext): Promise<void> {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });
      if (!runtimeAdapter) {
        throw new Error('[slingshot-webhooks] Manifest adapters were not resolved during setup');
      }
      if ('initializeGovernance' in runtimeAdapter) {
        await (runtimeAdapter as WebhookAdapter & GovernedWebhookRuntime).initializeGovernance(
          events.definitions,
        );
      }
      getPluginState(app).set(WEBHOOKS_PLUGIN_STATE_KEY, runtimeAdapter);
      // Resolve the framework-owned metrics emitter so the dispatcher
      // pipeline publishes counters/gauges/timings on hot paths.
      const ctx = getContextOrNull(app);
      if (ctx?.metricsEmitter) resolvedMetricsEmitter = ctx.metricsEmitter;
      unsubscribers = await activate(bus, events, config, queue, runtimeAdapter, metricsProxy);
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

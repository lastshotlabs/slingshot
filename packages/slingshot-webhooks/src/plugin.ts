/**
 * Webhooks package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts the WebhookEndpoint and
 * WebhookDelivery entities, wires the queue lifecycle, dispatches delivery
 * jobs, supplies the `/endpoints/:id/test` and `/admin/deliveries/:id/replay`
 * routes, and mounts the inbound webhook receiver router. Cross-package
 * consumers resolve the runtime adapter via {@link WebhookAdapterCap}.
 *
 * Every adapter ref, queue handle, rate-limit backend, and inbound router
 * closure is owned by the factory's closure (Rule 3) — multiple package
 * instances in the same process do not share state.
 */
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  EventDefinitionRegistry,
  MetricsEmitter,
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  HeaderInjectionError,
  SafeFetchBlockedError,
  SafeFetchDnsError,
  createConsoleLogger,
  createNoopMetricsEmitter,
  deepFreeze,
  definePackage,
  getActor,
  getContextOrNull,
  getRouteAuthOrNull,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { buildWebhookEntityModules } from './entities/modules';
import {
  type WebhookAdapterRefs,
  type WebhookRuntimeAdapter,
  buildWebhookRuntimeAdapter,
  createWebhookSecretCipher,
} from './entities/runtime';
import { WebhookConfigError, WebhookRuntimeError } from './errors/webhookErrors';
import type { DispatchOptions } from './lib/dispatcher';
import { deliverWebhook } from './lib/dispatcher';
import { wireEventSubscriptions } from './lib/eventWiring';
import { logWebhookEvent } from './lib/log';
import type { RateLimiter } from './lib/rateLimit';
import { createSlidingWindowRateLimiter } from './lib/rateLimit';
import { WebhookAdapterCap } from './public';
import { createWebhookMemoryQueue } from './queues/memory';
import { createInboundRouter } from './routes/inbound';
import { WEBHOOK_ROUTES } from './routes/index';
import type { WebhookAdapter } from './types/adapter';
import type { WebhookPluginConfig } from './types/config';
import { webhookPluginConfigSchema } from './types/config';
import type { InboundProvider } from './types/inbound';
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

/**
 * P-WEBHOOKS-9: clamp a caller-requested delivery timeout at 120s with a
 * loud warning + `webhook:timeoutClamped` event. Exported so unit tests can
 * exercise the clamp without standing up the full package lifecycle.
 */
export const TIMEOUT_CLAMP_MS = 120_000;

export function clampDeliveryTimeoutMs(
  requestedMs: number,
  ctx: { deliveryId: string; endpointId: string },
  bus: SlingshotEventBus | undefined,
): number {
  if (requestedMs <= TIMEOUT_CLAMP_MS) return requestedMs;
  logWebhookEvent('warn', 'webhook timeout clamped', {
    deliveryId: ctx.deliveryId,
    endpointId: ctx.endpointId,
    requestedTimeoutMs: requestedMs,
    clampedTimeoutMs: TIMEOUT_CLAMP_MS,
  });
  try {
    bus?.emit?.('webhook:timeoutClamped', {
      deliveryId: ctx.deliveryId,
      endpointId: ctx.endpointId,
      requestedTimeoutMs: requestedMs,
      clampedTimeoutMs: TIMEOUT_CLAMP_MS,
    });
  } catch {
    // bus emission must never break delivery
  }
  return TIMEOUT_CLAMP_MS;
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

function configuredDispatchOptions(config: Readonly<WebhookPluginConfig>): DispatchOptions {
  const dispatch = config.dispatch;
  return {
    ...(dispatch?.fetchImpl ? { fetchImpl: dispatch.fetchImpl } : {}),
    ...(dispatch?.safeFetchOverrides ? { safeFetchOverrides: dispatch.safeFetchOverrides } : {}),
  };
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
      const resolvedTimeoutMs = clampDeliveryTimeoutMs(
        requestedTimeoutMs,
        {
          deliveryId: job.deliveryId,
          endpointId: job.endpointId,
        },
        bus,
      );
      await deliverWebhook(job, {
        ...configuredDispatchOptions(config),
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

async function resolveTestDelivery(
  runtime: WebhookAdapter,
  config: Readonly<WebhookPluginConfig>,
  endpointId: string,
  bus?: SlingshotEventBus,
): Promise<{ deliveryId: string; status: number; ok: boolean; body: string; durationMs: number }> {
  const endpoint = await runtime.getEndpoint(endpointId);
  if (!endpoint) {
    throw new WebhookRuntimeError('Endpoint not found');
  }

  const eventId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const payload = JSON.stringify({
    test: true,
    endpointId,
    timestamp: occurredAt,
  });
  const delivery = await runtime.createDelivery({
    endpointId,
    event: 'webhook:test' as never,
    eventId,
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

  const requestedTimeoutMs = endpoint.deliveryTimeoutMs ?? config.deliveryTimeoutMs ?? 30_000;
  const timeoutMs = clampDeliveryTimeoutMs(
    requestedTimeoutMs,
    {
      deliveryId: delivery.id,
      endpointId,
    },
    bus,
  );
  const attemptedAt = new Date().toISOString();
  const start = Date.now();
  let status = 0;
  let body = '';
  let ok = false;
  const job: WebhookJob = {
    id: 'test-' + eventId,
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
    createdAt: new Date(),
    deliveryTimeoutMs: endpoint.deliveryTimeoutMs ?? null,
  };

  try {
    await deliverWebhook(job, {
      ...configuredDispatchOptions(config),
      timeoutMs,
      extraHeaders: { 'X-Webhook-Test': 'true' },
      onResponse: async res => {
        status = res.status;
        ok = res.ok;
        body = await res.text().catch(() => '');
      },
    });
    const durationMs = Date.now() - start;
    await runtime.updateDelivery(delivery.id, {
      status: 'delivered',
      attempts: 1,
      nextRetryAt: null,
      lastAttempt: { attemptedAt, statusCode: status, durationMs },
    });
    return { deliveryId: delivery.id, status, ok, body: body.slice(0, 4096), durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    await runtime.updateDelivery(delivery.id, {
      status: status > 0 ? 'dead' : 'failed',
      attempts: 1,
      nextRetryAt: null,
      lastAttempt: {
        attemptedAt,
        ...(status > 0 ? { statusCode: status } : {}),
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (status > 0) {
      return { deliveryId: delivery.id, status, ok, body: body.slice(0, 4096), durationMs };
    }
    throw err;
  }
}

/**
 * Create the webhooks package using the `definePackage` authoring path.
 *
 * Mounts the WebhookEndpoint and WebhookDelivery entities (each with manual
 * adapter wiring that wraps the standard adapter in subscription
 * normalization, secret encryption, and the transition state machine),
 * starts the queue lifecycle, supplies the bespoke `/endpoints/:id/test`
 * and `/admin/deliveries/:id/replay` routes plus the inbound webhook
 * receiver, and publishes the unified {@link WebhookAdapterCap} capability
 * once the runtime is ready.
 *
 * When `config.adapter` is supplied, the package skips entity wiring and
 * uses the caller-provided adapter directly — the entity modules and routes
 * remain unmounted in that mode.
 */
export function createWebhooksPackage(rawConfig: WebhookPluginConfig): SlingshotPackageDefinition {
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
  const requireWebhookAdmin = buildRoleGuard(managementRole);
  const inboundRoutePatterns = buildInboundPublicPaths(
    mountPath,
    config.inbound,
    config.disableRoutes,
  );

  // Closure-owned state (Rule 3 — no globals).
  const refs: WebhookAdapterRefs = {};
  const definitionsRef: { current?: EventDefinitionRegistry } = {};
  let runtimeAdapter: WebhookAdapter | undefined;

  // Forwarding view published through `WebhookAdapterCap`. Constructed once
  // per package instance so consumers reading the cap at different lifecycle
  // phases observe a stable reference (===). All access defers to the live
  // `runtimeAdapter` ref — populated in `setupMiddleware` (external adapter
  // path) or `setupPost` (entity-driven path). Method access is bound to the
  // live adapter so destructured references work; `has` reflects the live
  // adapter's surface; symbol/`then` reads return `undefined` so capability
  // publication and `await` probes don't error before the runtime is wired.
  const adapterTarget = Object.create(null) as WebhookAdapter;
  const adapterView: WebhookAdapter = new Proxy<WebhookAdapter>(adapterTarget, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (!runtimeAdapter) {
        throw new WebhookRuntimeError(
          'WebhookAdapterCap accessed before the runtime adapter was wired (read it from `setupPost` or later).',
        );
      }
      const value = Reflect.get(runtimeAdapter as object, property);
      return typeof value === 'function' ? value.bind(runtimeAdapter) : value;
    },
    has(_target, property) {
      if (!runtimeAdapter) return false;
      return Reflect.has(runtimeAdapter as object, property);
    },
    ownKeys() {
      if (!runtimeAdapter) return [];
      return Reflect.ownKeys(runtimeAdapter as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!runtimeAdapter) return undefined;
      return Reflect.getOwnPropertyDescriptor(runtimeAdapter as object, property);
    },
  });
  let inboundRateLimiter: RateLimiter | undefined;
  let unsubscribers: Array<() => void> = [];

  // Lazy metrics resolution — proxied so the dispatcher pipeline picks up the
  // framework-owned emitter the moment setupPost runs.
  let resolvedMetricsEmitter: MetricsEmitter = createNoopMetricsEmitter();
  const metricsProxy: MetricsEmitter = {
    counter: (name, value, labels) => resolvedMetricsEmitter.counter(name, value, labels),
    gauge: (name, value, labels) => resolvedMetricsEmitter.gauge(name, value, labels),
    timing: (name, ms, labels) => resolvedMetricsEmitter.timing(name, ms, labels),
  };

  // Build entity modules eagerly so `definePackage` can declare them on
  // `entities: [...]`. When `config.adapter` is supplied the modules are
  // still constructed but stay unused — they're filtered out before the
  // package declaration to avoid mounting CRUD routes the caller does not
  // want.
  const entityModules = buildWebhookEntityModules({
    refs,
    definitionsRef,
    cipherOptions: {
      secretEncryptionKey: config.secretEncryptionKey ?? null,
      encryptor: config.encryptor ?? null,
    },
  });

  const middleware: Record<string, MiddlewareHandler> = {
    webhooksAdminGuard: requireWebhookAdmin,
  };

  const disabledRouteGroups = new Set(config.disableRoutes ?? []);
  const endpointsRouteGroupDisabled = disabledRouteGroups.has(WEBHOOK_ROUTES.ENDPOINTS);
  const useExternalAdapter = config.adapter !== undefined;
  const entities = useExternalAdapter || endpointsRouteGroupDisabled
    ? []
    : [entityModules.webhookEndpointModule, entityModules.webhookDeliveryModule];

  return definePackage({
    name: 'slingshot-webhooks',
    mountPath,
    dependencies: useExternalAdapter ? [] : ['slingshot-auth'],
    entities,
    middleware,
    publicPaths: inboundRoutePatterns,
    csrfExemptPaths: inboundRoutePatterns,
    capabilities: {
      // Always return the same long-lived `adapterView` Proxy. The framework
      // calls `provider.resolve()` twice (once at `setupMiddleware`, once at
      // `setupPost`) and republishes the cap slot each time — returning a
      // single stable reference means consumers reading the cap at any
      // lifecycle phase observe `===` identity.
      provides: [provideCapability(WebhookAdapterCap, () => adapterView)],
    },

    async setupMiddleware() {
      if (useExternalAdapter) {
        runtimeAdapter = config.adapter;
        return;
      }

      // Production safety: secret encryption is required unless the host
      // app explicitly opts in to plaintext storage.
      if (!config.secretEncryptionKey && !config.encryptor) {
        const pluginLogger: Logger = createConsoleLogger({
          base: { plugin: 'slingshot-webhooks' },
        });
        if (process.env.NODE_ENV === 'production') {
          if (!config.allowPlaintextSecrets) {
            throw new WebhookConfigError(
              'secret encryption is required in production. ' +
                'Set secretEncryptionKey, supply a custom encryptor, or explicitly set ' +
                'allowPlaintextSecrets: true if storage encryption is handled externally.',
            );
          }
          pluginLogger.warn(
            '[slingshot-webhooks] allowPlaintextSecrets is enabled in production. ' +
              'Webhook secrets will be stored without encryption. Ensure storage-layer ' +
              'encryption is handled externally (e.g. encrypted DB, KMS).',
          );
        }
        pluginLogger.warn(
          '[slingshot-webhooks] no secret encryption is configured. Endpoint secrets ' +
            'will be stored as plaintext. Set secretEncryptionKey to a base64 32-byte AES key, ' +
            'or supply a custom `encryptor`, before exposing this app to production traffic.',
        );
      }
    },

    async setupRoutes({ app, bus }: PluginSetupContext) {
      const adapterIsReady = (): WebhookAdapter | undefined => runtimeAdapter ?? refs.runtime;

      if (!endpointsRouteGroupDisabled) {
        app.post(`${mountPath}/endpoints/:id/test`, requireWebhookAdmin, async c => {
          const adapter = adapterIsReady();
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
          try {
            const result = await resolveTestDelivery(adapter, config, endpointId, bus);
            return c.json(result, 200);
          } catch (err) {
            if (
              err instanceof WebhookRuntimeError &&
              err.message === '[slingshot-webhooks] Endpoint not found'
            ) {
              return c.json({ error: 'Endpoint not found' }, 404);
            }
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: 'Test delivery failed', message }, 502);
          }
        });

        // Replay endpoint: re-queues a failed delivery for a retry attempt.
        app.post(
          `${mountPath}/admin/deliveries/:deliveryId/replay`,
          requireWebhookAdmin,
          async c => {
            const adapter = adapterIsReady();
            if (!adapter) {
              return c.json({ error: 'Webhook runtime is not ready' }, 500);
            }

            const deliveryId = c.req.param('deliveryId');
            const delivery = await adapter.getDelivery(deliveryId);
            if (!delivery) {
              return c.json({ error: 'Delivery not found' }, 404);
            }
            if (delivery.status === 'delivered') {
              return c.json({ error: 'Cannot replay a delivered webhook' }, 400);
            }

            const endpoint = await adapter.getEndpoint(delivery.endpointId);
            if (!endpoint) {
              return c.json({ error: 'Endpoint not found' }, 404);
            }

            const job: WebhookJob = {
              id: crypto.randomUUID(),
              deliveryId: delivery.id,
              endpointId: delivery.endpointId,
              url: endpoint.url,
              secret: endpoint.secret,
              event: delivery.event,
              eventId: delivery.eventId,
              occurredAt: delivery.occurredAt,
              subscriber: delivery.subscriber,
              payload: delivery.projectedPayload,
              attempts: 0,
              createdAt: new Date(),
              deliveryTimeoutMs: endpoint.deliveryTimeoutMs ?? null,
            };

            await queue.enqueue(job);
            await adapter.updateDelivery(deliveryId, {
              status: 'pending',
              attempts: 0,
              nextRetryAt: null,
            });

            return c.json({ replayed: true, deliveryId }, 200);
          },
        );
      }

      if ((config.inbound?.length ?? 0) > 0 && !disabledRouteGroups.has(WEBHOOK_ROUTES.INBOUND)) {
        // Resolve the rate limiter so the package owns the lifecycle — the
        // built-in sliding window limiter creates a periodic cleanup timer
        // that must be released on teardown to prevent timer leaks across
        // reloads.
        let resolvedInboundRateLimiter: RateLimiter | undefined;
        if (config.inboundRateLimit) {
          if (
            'check' in config.inboundRateLimit &&
            typeof config.inboundRateLimit.check === 'function'
          ) {
            resolvedInboundRateLimiter = config.inboundRateLimit as RateLimiter;
          } else {
            resolvedInboundRateLimiter = createSlidingWindowRateLimiter(
              config.inboundRateLimit as { maxRequests?: number; windowMs?: number },
            );
            inboundRateLimiter = resolvedInboundRateLimiter;
          }
        }

        app.route(
          `${mountPath}/inbound`,
          createInboundRouter([...(config.inbound ?? [])], bus, {
            maxBodyBytes: config.inboundMaxBodyBytes,
            rateLimiter: resolvedInboundRateLimiter,
          }),
        );
      }
    },

    async setupPost({ app, bus, events }: PluginSetupContext) {
      // When using a caller-supplied adapter the runtime is already in place
      // — skip entity-adapter resolution and governance init.
      if (!useExternalAdapter) {
        if (!refs.endpoint || !refs.delivery) {
          throw new WebhookRuntimeError(
            'webhook entity adapters were not captured during setup',
          );
        }
        const logger = createConsoleLogger({ base: { component: 'slingshot-webhooks' } });
        const cipher = createWebhookSecretCipher({
          secretEncryptionKey: config.secretEncryptionKey ?? null,
          encryptor: config.encryptor ?? null,
        });
        const runtime: WebhookRuntimeAdapter = buildWebhookRuntimeAdapter(
          refs.endpoint,
          refs.delivery,
          cipher,
          logger as unknown as Parameters<typeof buildWebhookRuntimeAdapter>[3],
          definitionsRef,
        );
        refs.runtime = runtime;
        runtimeAdapter = runtime;
        await runtime.initializeGovernance(events.definitions);
      }

      if (!runtimeAdapter) {
        throw new WebhookRuntimeError('Manifest adapters were not resolved during setup');
      }

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
      inboundRateLimiter?.close?.();
      inboundRateLimiter = undefined;
      await queue.stop();
    },
  });
}

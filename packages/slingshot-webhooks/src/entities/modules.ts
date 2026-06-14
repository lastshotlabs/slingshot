/**
 * Package-authoring entity modules for the webhooks package.
 *
 * Each entity uses `wiring: { mode: 'manual', buildAdapter }` so the package
 * factory can:
 *
 *   - Resolve the config-driven adapter via the framework's standard factory
 *     pipeline (the same path the standard wiring mode uses internally).
 *   - Wrap the adapter in the per-entity runtime transforms (subscription
 *     normalization + secret encryption for WebhookEndpoint, transition state
 *     machine for WebhookDelivery).
 *   - Publish the wrapped adapter into the shared {@link WebhookAdapterRefs}
 *     bag so the lifted `transition` custom-op handler and the high-level
 *     runtime adapter all see the same instance per entity.
 *
 * The bespoke `transition` route is wired through `overrides.operations` on
 * the WebhookDelivery module — the route's auth/middleware come straight
 * from the entity's `routes.operations.transition` config so the HTTP
 * contract is unchanged.
 *
 * @internal
 */
import type { EventDefinitionRegistry, StoreInfra, StoreType } from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityRouteExecutionContext,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorOverrides,
} from '@lastshotlabs/slingshot-entity';
import {
  type WebhookAdapterRefs,
  applyWebhookDeliveryRuntimeTransform,
  applyWebhookEndpointRuntimeTransform,
  createDeliveryTransitionHandler,
  requireDeliveryRuntimeAdapter,
  requireEndpointRuntimeAdapter,
} from './runtime';
import type { WebhookSecretCipherOptions } from './runtime';
import { createWebhookSecretCipher } from './runtime';
import { WebhookDeliveryEntity, webhookDeliveryOperations } from './webhookDelivery';
import { WebhookEndpointEntity } from './webhookEndpoint';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter for an entity via the framework's
 * standard-wiring code path so manual-wiring entities here behave the same
 * as the default factory pipeline.
 */
function resolveStandardAdapter(args: {
  config: Parameters<typeof createEntityFactories>[0];
  operations?: Parameters<typeof createEntityFactories>[1];
  storeType: StoreType;
  infra: StoreInfra;
}): BareEntityAdapter {
  const creator = Reflect.get(args.infra as object, RESOLVE_ENTITY_FACTORIES) as
    | EntityFactoryCreator
    | undefined;
  const factoryCreator = creator ?? createEntityFactories;
  const factories = args.operations
    ? factoryCreator(args.config, args.operations)
    : factoryCreator(args.config);
  return resolveRepo(factories, args.storeType, args.infra) as unknown as BareEntityAdapter;
}

export interface BuildWebhookEntityModulesArgs {
  /** Shared adapter refs populated as each entity is wired. */
  refs: WebhookAdapterRefs;
  /**
   * Closure-shared event definitions registry. Filled in by the package
   * factory inside `setupPost(...)` so endpoint writes can normalize
   * subscriptions against the active registry.
   */
  definitionsRef: { current?: EventDefinitionRegistry };
  /** Secret-encryption configuration (key or custom encryptor). */
  cipherOptions: WebhookSecretCipherOptions;
}

/**
 * Build the two webhook entity modules. Returns both modules ready for
 * `definePackage({ entities: [...] })`.
 */
export function buildWebhookEntityModules(args: BuildWebhookEntityModulesArgs) {
  const { refs, definitionsRef, cipherOptions } = args;
  const cipher = createWebhookSecretCipher(cipherOptions);

  // ─── Custom-op handler wrappers as entity-route override executors ────────
  const transitionHandler = createDeliveryTransitionHandler(refs);

  const wrapHandler =
    (handler: (input: unknown) => Promise<unknown>): EntityRouteExecutorBuilder =>
    () =>
    async (ctx: EntityRouteExecutionContext) => {
      const result = await handler(ctx.input);
      if (result === null) {
        return ctx.respond.json(null);
      }
      return ctx.respond.json(result as Record<string, unknown>);
    };

  const webhookDeliveryOverrides: EntityRouteExecutorOverrides = {
    operations: {
      transition: wrapHandler(transitionHandler),
    },
  };

  // ─── WebhookEndpoint ──────────────────────────────────────────────────────
  const webhookEndpointModule = entity({
    config: WebhookEndpointEntity,
    path: 'endpoints',
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({
          config: WebhookEndpointEntity,
          storeType,
          infra,
        });
        const wrapped = applyWebhookEndpointRuntimeTransform(base, cipher, definitionsRef);
        refs.endpoint = requireEndpointRuntimeAdapter(wrapped);
        return wrapped;
      },
    },
  });

  // ─── WebhookDelivery ──────────────────────────────────────────────────────
  const webhookDeliveryModule = entity({
    config: WebhookDeliveryEntity,
    operations: webhookDeliveryOperations,
    path: 'endpoints/:endpointId/deliveries',
    overrides: webhookDeliveryOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({
          config: WebhookDeliveryEntity,
          operations: webhookDeliveryOperations.operations,
          storeType,
          infra,
        });
        const wrapped = applyWebhookDeliveryRuntimeTransform(base);
        refs.delivery = requireDeliveryRuntimeAdapter(wrapped);
        return wrapped;
      },
    },
  });

  return {
    webhookEndpointModule,
    webhookDeliveryModule,
  };
}

/**
 * Package-authoring entity module for the Asset entity.
 *
 * Uses `wiring: { mode: 'manual', buildAdapter }` so the package factory can:
 *
 *   - Resolve a config-driven adapter via `createEntityFactories(...)` (or the
 *     framework-supplied resolver from `RESOLVE_ENTITY_FACTORIES`),
 *   - Apply the asset-TTL transform inline,
 *   - Hand the resolved (TTL-wrapped) adapter back to the package via the
 *     `onAdapter` callback so the delete-cascade middleware and custom-op
 *     handlers all see the same adapter instance (Rule 3).
 *
 * The three bespoke routes (`presignUpload`, `presignDownload`, `serveImage`)
 * are declared as `overrides.operations` on this module. Their route paths
 * and middleware come from the entity's `routes.operations.*` config.
 *
 * @internal
 */
import type { StoreInfra, StoreType } from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityRouteExecutionContext,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorOverrides,
} from '@lastshotlabs/slingshot-entity';
import type { AssetAdapter } from '../types';
import { Asset, assetOperations } from './asset';
import { DEFAULT_ASSET_REGISTRY_TTL_SECONDS } from './factories';
import {
  type AssetsHandlerDeps,
  applyAssetTtlTransform,
  createPresignDownloadHandler,
  createPresignUploadHandler,
  createServeImageHandler,
} from './runtime';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter for an entity. Matches the framework's
 * standard-wiring code path so manual-wiring entities here behave the same
 * as the default factory pipeline.
 */
function resolveStandardAdapter(args: {
  storeType: StoreType;
  infra: StoreInfra;
}): BareEntityAdapter {
  const creator = Reflect.get(args.infra as object, RESOLVE_ENTITY_FACTORIES) as
    | EntityFactoryCreator
    | undefined;
  const factoryCreator = creator ?? createEntityFactories;
  const factories = factoryCreator(Asset, assetOperations.operations);
  return resolveRepo(factories, args.storeType, args.infra) as unknown as BareEntityAdapter;
}

/**
 * Build the Asset entity module wired to share its resolved (TTL-wrapped)
 * adapter with the package through `onAdapter`. The asset-specific custom-op
 * handlers (`presignUpload` / `presignDownload` / `serveImage`) are bound as
 * entity-route executor overrides so they reuse the entity's route auth,
 * middleware, and event configuration.
 */
export function buildAssetsEntityModules(args: {
  registryTtlSeconds: number | undefined;
  onAdapter: (adapter: AssetAdapter) => void;
  handlerDeps: AssetsHandlerDeps;
}) {
  const ttlSeconds = args.registryTtlSeconds ?? DEFAULT_ASSET_REGISTRY_TTL_SECONDS;

  const presignUpload = createPresignUploadHandler(args.handlerDeps);
  const presignDownload = createPresignDownloadHandler(args.handlerDeps);
  const serveImage = createServeImageHandler(args.handlerDeps);

  /**
   * Bind a JSON-returning custom-op handler to an entity route executor.
   * Routing, auth, and middleware are sourced from the entity's
   * `routes.operations.{name}` config.
   */
  const wrapJsonHandler =
    (handler: (input: unknown) => Promise<unknown>): EntityRouteExecutorBuilder =>
    () =>
    async (ctx: EntityRouteExecutionContext) => {
      const result = await handler(ctx.input);
      if (result === null) {
        return ctx.respond.json(null);
      }
      return ctx.respond.json(result as Record<string, unknown>);
    };

  /**
   * `serveImage` returns a streaming `Response` already — the route executor
   * forwards it directly to the client.
   */
  const wrapResponseHandler =
    (handler: (input: unknown) => Promise<Response>): EntityRouteExecutorBuilder =>
    () =>
    async (ctx: EntityRouteExecutionContext) => {
      return handler(ctx.input);
    };

  const overrides: EntityRouteExecutorOverrides = {
    operations: {
      presignUpload: wrapJsonHandler(presignUpload),
      presignDownload: wrapJsonHandler(presignDownload),
      serveImage: wrapResponseHandler(serveImage),
    },
  };

  const assetModule = entity({
    config: Asset,
    operations: assetOperations,
    overrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({ storeType, infra });
        const wrapped = applyAssetTtlTransform(base, ttlSeconds);
        args.onAdapter(wrapped as unknown as AssetAdapter);
        return wrapped;
      },
    },
  });

  return { assetModule };
}

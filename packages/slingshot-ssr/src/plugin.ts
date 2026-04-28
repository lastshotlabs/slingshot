import path from 'node:path';
import type {
  PluginSetupContext,
  ResolvedEntityConfig,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import { getPluginState } from '@lastshotlabs/slingshot-core';
import { buildActionRouter } from './actions/routes';
import { SsrAssetManifestError, type ViteManifest, readAssetManifest } from './assets';
import { ssrPluginConfigSchema } from './config.schema';
import { buildDraftRouter } from './draft/routes';
import { createMemoryIsrCache } from './isr/memory';
import {
  type IsrInvalidators,
  SSR_ISR_INVALIDATORS_STATE_KEY,
  createIsrInvalidators,
} from './isr/revalidate';
import { registerMetadataRoutes } from './metadata/index';
import { buildSsrMiddleware } from './middleware';
import { buildPageRouteTable } from './pageResolver';
import { initRouteTree, invalidateRouteTree } from './resolver';
import type { SsrPluginConfig } from './types';

function toTagValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

/**
 * Create a Slingshot SSR plugin.
 *
 * Registers SSR middleware, server action routes, metadata routes, and
 * optional entity-driven page support when `config.pages` is supplied.
 *
 * @param rawConfig - Plugin configuration validated at construction time.
 * @returns A Slingshot plugin instance for app registration.
 */
export function createSsrPlugin(rawConfig: SsrPluginConfig): SlingshotPlugin {
  const validated = ssrPluginConfigSchema.parse(rawConfig);
  const config: Readonly<SsrPluginConfig> = Object.freeze({
    ...rawConfig,
    serverRoutesDir: validated.serverRoutesDir,
    assetsManifest: validated.assetsManifest,
    entryPoint: validated.entryPoint,
    cacheControl: validated.cacheControl,
    exclude: validated.exclude,
    devMode: validated.devMode,
    staticDir: validated.staticDir,
    isr: rawConfig.isr,
    trustedOrigins: rawConfig.trustedOrigins,
    serverActionsDir: rawConfig.serverActionsDir,
    runtime: rawConfig.runtime,
    draftModeSecret: rawConfig.draftModeSecret,
    pages: rawConfig.pages,
    navigation: rawConfig.navigation,
  });

  const isDevMode = config.devMode ?? process.env.NODE_ENV === 'development';
  const isrAdapter =
    config.isr !== undefined ? (config.isr.adapter ?? createMemoryIsrCache()) : null;
  let isrInvalidators: IsrInvalidators | undefined;
  let entityConfigMap = new Map<string, ResolvedEntityConfig>();
  const unsubscribers: Array<() => void> = [];

  return {
    name: 'slingshot-ssr',

    setupRoutes({ app }: PluginSetupContext) {
      if (config.draftModeSecret !== undefined && config.draftModeSecret.length > 0) {
        app.route('/api/draft', buildDraftRouter(config.draftModeSecret));
      }
    },

    setupMiddleware({ app }: PluginSetupContext) {
      let manifest: ViteManifest | null = null;
      if (!isDevMode) {
        const rawManifest = config.assetsManifest.trimStart();
        if (rawManifest.startsWith('{')) {
          try {
            manifest = JSON.parse(rawManifest) as ViteManifest;
          } catch {
            throw new Error(
              '[slingshot-ssr] assetsManifest looks like inline JSON but failed to parse. ' +
                'Provide valid JSON or a path to the manifest file.',
            );
          }
        } else {
          try {
            manifest = readAssetManifest(config.assetsManifest);
          } catch (err) {
            if (err instanceof SsrAssetManifestError) {
              throw new Error(
                `[slingshot-ssr] Cannot start in production mode without an asset manifest.\n` +
                  `Run your build before starting the server.\n` +
                  err.message,
                { cause: err },
              );
            }
            throw err;
          }
        }
      }

      initRouteTree(config.serverRoutesDir);

      if (isrAdapter !== null) {
        isrInvalidators = createIsrInvalidators(isrAdapter);
        getPluginState(app).set(SSR_ISR_INVALIDATORS_STATE_KEY, isrInvalidators);
      }

      const serverActionsDir =
        config.serverActionsDir ?? path.resolve(process.cwd(), 'server/actions');

      app.route(
        '/_snapshot',
        buildActionRouter({
          trustedOrigins: config.trustedOrigins ?? [],
          serverActionsDir,
          isrInvalidators,
        }),
      );

      registerMetadataRoutes(app, config.serverRoutesDir);

      app.use('*', buildSsrMiddleware(config, manifest, app, isrAdapter));

      if (isDevMode) {
        setupDevWatcher(config.serverRoutesDir);
      }
    },

    setupPost({ bus, config: frameworkConfig }: PluginSetupContext) {
      entityConfigMap = new Map(
        frameworkConfig.entityRegistry
          .getAll()
          .map(entityConfig => [entityConfig.name, entityConfig]),
      );

      if (config.pages) {
        buildPageRouteTable(config.pages, entityConfigMap);
      }

      if (!config.pages || !isrInvalidators) {
        return;
      }

      // Entity CRUD events use dynamic string keys (e.g. `entity:users.created`).
      // SlingshotEventBus.on(string, ...) accepts `(payload: unknown)` listeners
      // directly; we narrow inside the handler.
      for (const entityConfig of collectReferencedEntities(config.pages, entityConfigMap)) {
        for (const eventName of [
          `entity:${entityConfig._storageName}.created`,
          `entity:${entityConfig._storageName}.updated`,
          `entity:${entityConfig._storageName}.deleted`,
        ]) {
          const listener = async (payload: unknown): Promise<void> => {
            await isrInvalidators?.revalidateTag(`entity:${entityConfig.name}`);

            const payloadRecord: Record<string, unknown> =
              payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
            const entityPayload = payloadRecord['entity'];
            const sourceRecord =
              entityPayload && typeof entityPayload === 'object'
                ? (entityPayload as Record<string, unknown>)
                : payloadRecord;
            const recordId = sourceRecord[entityConfig._pkField];
            if (recordId !== undefined && recordId !== null) {
              const entityRecordId = toTagValue(recordId);
              if (entityRecordId !== null) {
                await isrInvalidators?.revalidateTag(
                  `entity:${entityConfig.name}:${entityRecordId}`,
                );
              }
            }
          };

          bus.on(eventName, listener);
          unsubscribers.push(() => bus.off(eventName, listener));
        }
      }
    },

    teardown() {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers.length = 0;
      return Promise.resolve();
    },
  };
}

function collectReferencedEntities(
  pages: Readonly<Record<string, NonNullable<SsrPluginConfig['pages']>[string]>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
): ResolvedEntityConfig[] {
  const entities = new Map<string, ResolvedEntityConfig>();

  for (const page of Object.values(pages)) {
    if ('entity' in page && typeof page.entity === 'string') {
      const entityConfig = entityConfigs.get(page.entity);
      if (entityConfig) {
        entities.set(entityConfig.name, entityConfig);
      }
    }

    if (page.type === 'entity-dashboard') {
      for (const stat of page.stats) {
        const entityConfig = entityConfigs.get(stat.entity);
        if (entityConfig) {
          entities.set(entityConfig.name, entityConfig);
        }
      }

      if (page.activity) {
        const entityConfig = entityConfigs.get(page.activity.entity);
        if (entityConfig) {
          entities.set(entityConfig.name, entityConfig);
        }
      }

      if (page.chart) {
        const entityConfig = entityConfigs.get(page.chart.entity);
        if (entityConfig) {
          entities.set(entityConfig.name, entityConfig);
        }
      }
    }
  }

  return [...entities.values()];
}

/**
 * Set up a best-effort file watcher in dev mode to auto-invalidate the route
 * tree when files are added, changed, or removed in the server routes directory.
 *
 * @param serverRoutesDir - Absolute path to the server routes directory.
 */
function setupDevWatcher(serverRoutesDir: string): void {
  try {
    const bunGlobal = globalThis as Record<string, unknown>;
    const bun = bunGlobal['Bun'] as
      | { watch?: (path: string, opts: { recursive: boolean }) => EventTarget }
      | undefined;

    const watcher = bun?.watch?.(serverRoutesDir, { recursive: true });
    if (!watcher) return;

    watcher.addEventListener('change', () => {
      invalidateRouteTree(serverRoutesDir);
      initRouteTree(serverRoutesDir);
    });
  } catch {
    // Best-effort only.
  }
}

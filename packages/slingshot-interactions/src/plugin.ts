import type {
  PluginSetupContext,
  SlingshotPackageDefinition,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  defineEvent,
  definePackage,
  getPermissionsStateOrNull,
  getPluginState,
  getRateLimitAdapter,
  provideCapability,
  publishPluginState,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import { InteractionsRuntimeCap } from './public';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { interactionsPluginConfigSchema } from './config/schema';
import type { InteractionsPluginConfig } from './config/types';
import { interactionEventFactories } from './entities/factories';
import { interactionEventModule } from './entities/interactionEvent';
import { compileHandlers } from './handlers/compile';
import { probeChatPeer } from './peers/chat';
import { probeCommunityPeer } from './peers/community';
import { buildDispatchRoute } from './routes/dispatchRoute';
import { INTERACTIONS_PLUGIN_STATE_KEY, type InteractionsPluginState } from './state';

type InteractionEventsAdapter = BareEntityAdapter;
type InteractionsLogger = Pick<Console, 'warn' | 'info' | 'debug'>;

/**
 * Create the interactions package.
 *
 * Validates `rawConfig` via `interactionsPluginConfigSchema`, compiles all
 * declarative handler templates into dispatchers, and exposes:
 *  - `POST {mountPath}/dispatch` — the bespoke interaction dispatch endpoint.
 *  - `GET /interactionEvents` / `GET /interactionEvents/:id` — entity-generated
 *    read routes for the user-scoped audit log (provided by the entity module).
 *
 * @param rawConfig - Package config. Validated against `interactionsPluginConfigSchema`.
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 */
export function createInteractionsPackage(rawConfig: unknown): SlingshotPackageDefinition {
  const config: InteractionsPluginConfig = interactionsPluginConfigSchema.parse(rawConfig);

  let interactionEventsAdapterRef: InteractionEventsAdapter | undefined;
  let stateRef: InteractionsPluginState | undefined;

  return definePackage({
    name: INTERACTIONS_PLUGIN_STATE_KEY,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth', 'slingshot-permissions'],
    entities: [interactionEventModule],
    capabilities: {
      provides: [
        // Return a Proxy: the framework eagerly resolves capability values at
        // setupMiddleware time. Field access throws a clear error if reached
        // before our setupMiddleware populates `stateRef`.
        provideCapability(InteractionsRuntimeCap, () => {
          const target: InteractionsPluginState = Object.create(null) as InteractionsPluginState;
          return new Proxy(target, {
            get(_target, prop, receiver) {
              if (typeof prop === 'symbol' || prop === 'then') return undefined;
              if (!stateRef) {
                throw new Error(
                  `[slingshot-interactions] runtime.${String(prop)} accessed before setupMiddleware completed; resolve InteractionsRuntimeCap from setupRoutes or later.`,
                );
              }
              return Reflect.get(stateRef, prop, receiver);
            },
          });
        }),
      ],
    },

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      // Resolve the InteractionEvent adapter imperatively so the dispatch route
      // (mounted in setupRoutes) has a stable ref. The entity module itself
      // also goes through the framework's entity-plugin path, which resolves
      // the same factory again for its CRUD routes — two cheap resolutions of
      // the same factory are simpler than threading a ref through the entity
      // plugin's onAdapter callback.
      const storeType: StoreType = frameworkConfig.resolvedStores.authStore;
      const infra: StoreInfra = frameworkConfig.storeInfra;
      interactionEventsAdapterRef = resolveRepo(
        interactionEventFactories,
        storeType,
        infra,
      ) as unknown as BareEntityAdapter;

      const pluginState = getPluginState(app);
      const permissions = getPermissionsStateOrNull(pluginState);
      if (!permissions) {
        throw new Error(
          '[slingshot-interactions] Permissions state not found. Register createPermissionsPackage() first.',
        );
      }

      if (!events.get('interactions:event.dispatched')) {
        events.register(
          defineEvent('interactions:event.dispatched', {
            ownerPlugin: INTERACTIONS_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                userId: payload.userId,
                actorId: payload.userId,
              };
            },
          }),
        );
      }
      if (!events.get('interactions:event.failed')) {
        events.register(
          defineEvent('interactions:event.failed', {
            ownerPlugin: INTERACTIONS_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                userId: payload.userId,
                actorId: payload.userId,
              };
            },
          }),
        );
      }

      const runtimeOverlay = new Map<
        string,
        ReturnType<typeof compileHandlers>['byPrefix'][string]
      >();
      const compiled = compileHandlers(config.handlers, { app, bus });

      const state: InteractionsPluginState = {
        handlers: {
          byPrefix: compiled.byPrefix,
          sortedKeys: compiled.sortedKeys,
          resolve(actionId) {
            const runtimePrefixes = [...runtimeOverlay.keys()].sort((a, b) => b.length - a.length);
            for (const prefix of runtimePrefixes) {
              if (actionId === prefix || actionId.startsWith(prefix)) {
                return runtimeOverlay.get(prefix) ?? null;
              }
            }
            return compiled.resolve(actionId);
          },
        },
        rateLimit: getRateLimitAdapter(app),
        permissions,
        bus,
        events,
        rateLimitWindowMs: config.rateLimit.windowMs,
        rateLimitMax: config.rateLimit.max,
        peers: {
          chat: probeChatPeer(pluginState),
          community: probeCommunityPeer(pluginState),
        },
        repos: {
          interactionEvents: null,
        },
        logger: console satisfies InteractionsLogger,
        registerHandler(prefix, dispatcher) {
          runtimeOverlay.set(prefix, {
            prefix,
            template: { kind: 'queue', target: prefix, fireAndForget: false },
            dispatcher,
          });
        },
      };

      stateRef = state;
      publishPluginState(pluginState, INTERACTIONS_PLUGIN_STATE_KEY, state);
    },

    // Returns a Promise so callers/tests can use `await … .rejects.toThrow(…)`
    // against the missing-adapter check below. The hook contract is
    // `() => void | Promise<void>`; we choose Promise to make the failure
    // observable through the same surface as async lifecycle hooks.
    // eslint-disable-next-line @typescript-eslint/require-await
    async setupRoutes({ app }: PluginSetupContext) {
      if (!stateRef || !interactionEventsAdapterRef) {
        throw new Error(
          '[slingshot-interactions] InteractionEvent adapter was not resolved during setupRoutes',
        );
      }

      stateRef.repos.interactionEvents = interactionEventsAdapterRef;
      buildDispatchRoute(app, stateRef, config.mountPath);
    },

    setupPost({ app }: PluginSetupContext) {
      const state =
        stateRef ??
        (getPluginState(app).get(INTERACTIONS_PLUGIN_STATE_KEY) as
          | InteractionsPluginState
          | undefined);
      if (!state) return;

      state.logger?.info?.(
        {
          plugin: INTERACTIONS_PLUGIN_STATE_KEY,
          handlerCount: state.handlers.sortedKeys.length,
          prefixes: state.handlers.sortedKeys,
          peers: {
            chat: state.peers.chat !== null,
            community: state.peers.community !== null,
          },
        },
        'slingshot-interactions ready',
      );
    },
  });
}

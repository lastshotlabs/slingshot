import type {
  PluginSetupContext,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  getPermissionsStateOrNull,
  getPluginState,
  getRateLimitAdapter,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { interactionsPluginConfigSchema } from './config/schema';
import type { InteractionsPluginConfig } from './config/types';
import { interactionEventFactories } from './entities/factories';
import { InteractionEvent, interactionEventOperations } from './entities/interactionEvent';
import { compileHandlers } from './handlers/compile';
import { probeChatPeer } from './peers/chat';
import { probeCommunityPeer } from './peers/community';
import { buildDispatchRoute } from './routes/dispatchRoute';
import { INTERACTIONS_PLUGIN_STATE_KEY, type InteractionsPluginState } from './state';

type InteractionEventsAdapter = BareEntityAdapter;
type InteractionsLogger = Pick<Console, 'warn' | 'info' | 'debug'>;

function toBareEntityAdapter(adapter: BareEntityAdapter): BareEntityAdapter {
  return adapter;
}

/**
 * Create the interactions plugin.
 *
 * Validates `rawConfig` via `interactionsPluginConfigSchema`, compiles all
 * declarative handler templates into dispatchers, and mounts:
 *  - `POST {mountPath}/dispatch` — the bespoke interaction dispatch endpoint.
 *  - `GET /interactionEvents` / `GET /interactionEvents/:id` — entity-generated
 *    read routes for the user-scoped audit log.
 *
 * @param rawConfig - Manifest-safe interactions config (JSON-safe, accepted
 *   from manifest bootstrap). Validated against `interactionsPluginConfigSchema`.
 * @returns A Slingshot plugin that mounts the dispatch route and interaction
 *   audit entity.
 *
 * @example
 * ```ts
 * import { createInteractionsPlugin } from '@lastshotlabs/slingshot-interactions';
 *
 * const plugin = createInteractionsPlugin({
 *   mountPath: '/interactions',
 *   rateLimit: { windowMs: 60_000, max: 20 },
 *   handlers: {
 *     'deploy:approve:': {
 *       kind: 'webhook',
 *       target: 'https://ci.example.com/interactions/deploy',
 *       signingSecret: process.env.WEBHOOK_SECRET,
 *     },
 *     'chat:react:': { kind: 'route', target: '/chat/reactions' },
 *     'jobs:':       { kind: 'queue', target: 'jobs:interactions.dispatched', fireAndForget: true },
 *   },
 * });
 * ```
 */
export function createInteractionsPlugin(rawConfig: unknown): SlingshotPlugin {
  const config: InteractionsPluginConfig = interactionsPluginConfigSchema.parse(rawConfig);

  let innerPlugin: EntityPlugin | undefined;
  let interactionEventsAdapterRef: InteractionEventsAdapter | undefined;
  let stateRef: InteractionsPluginState | undefined;

  const entities: EntityPluginEntry[] = [
    {
      config: InteractionEvent,
      routePath: 'interactionEvents',
      operations: interactionEventOperations.operations,
      buildAdapter(storeType: StoreType, infra: StoreInfra): BareEntityAdapter {
        const adapter: InteractionEventsAdapter = toBareEntityAdapter(
          resolveRepo(interactionEventFactories, storeType, infra) as unknown as BareEntityAdapter,
        );
        interactionEventsAdapterRef = adapter;
        return adapter;
      },
    },
  ];

  return {
    name: INTERACTIONS_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth', 'slingshot-permissions'],

    async setupMiddleware({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      const pluginState = getPluginState(app);
      const permissions = getPermissionsStateOrNull(pluginState);
      if (!permissions) {
        throw new Error(
          '[slingshot-interactions] Permissions state not found. Register createPermissionsPlugin() first.',
        );
      }

      bus.registerClientSafeEvents(['interactions:event.dispatched', 'interactions:event.failed']);

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
      pluginState.set(INTERACTIONS_PLUGIN_STATE_KEY, state);

      innerPlugin = createEntityPlugin({
        name: INTERACTIONS_PLUGIN_STATE_KEY,
        mountPath: config.mountPath,
        permissions,
        entities,
      });

      await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus });
    },

    async setupRoutes({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus });

      if (!stateRef || !interactionEventsAdapterRef) {
        throw new Error(
          '[slingshot-interactions] InteractionEvent adapter was not resolved during setupRoutes',
        );
      }

      stateRef.repos.interactionEvents = interactionEventsAdapterRef;
      buildDispatchRoute(app, stateRef, config.mountPath);
    },

    async setupPost({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus });

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
  };
}

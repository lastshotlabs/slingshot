import type {
  PluginSetupContext,
  SlingshotPackageDefinition,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  defineEvent,
  definePackage,
  getPermissionsStateOrNull,
  getPluginState,
  getRateLimitAdapter,
  provideCapability,
  publishPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { interactionsPluginConfigSchema } from './config/schema';
import type { InteractionsPluginConfig } from './config/types';
import { interactionEventFactories } from './entities/factories';
import { interactionEventModule } from './entities/interactionEvent';
import { compileHandlers } from './handlers/compile';
import { probeChatPeer } from './peers/chat';
import { probeCommunityPeer } from './peers/community';
import { InteractionsRuntimeCap } from './public';
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
  const config: InteractionsPluginConfig = deepFreeze(
    validatePluginConfig('slingshot-interactions', rawConfig, interactionsPluginConfigSchema),
  );

  let interactionEventsAdapterRef: InteractionEventsAdapter | undefined;
  let stateRef: InteractionsPluginState | undefined;

  // Long-lived Proxy view published through `InteractionsRuntimeCap`.
  // Constructed once per package instance so consumers reading the cap at
  // different lifecycle phases observe a stable reference (===). The
  // framework calls `provider.resolve()` twice (setupMiddleware + setupPost)
  // and republishes the cap slot each time; returning the same Proxy from
  // both calls keeps identity stable. All access defers to the live
  // `stateRef`; method access is bound to the live ref so destructured
  // references work; `has` reflects the live ref's surface; symbol/`then`
  // reads return `undefined` so capability publication and `await` probes
  // don't error before the runtime is wired.
  const runtimeTarget = Object.create(null) as InteractionsPluginState;
  const runtimeView: InteractionsPluginState = new Proxy<InteractionsPluginState>(runtimeTarget, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (!stateRef) {
        throw new Error(
          `[slingshot-interactions] runtime.${String(property)} accessed before setupMiddleware completed; resolve InteractionsRuntimeCap from setupRoutes or later.`,
        );
      }
      const value = Reflect.get(stateRef as object, property);
      return typeof value === 'function' ? value.bind(stateRef) : value;
    },
    has(_target, property) {
      if (!stateRef) return false;
      return Reflect.has(stateRef as object, property);
    },
    ownKeys() {
      if (!stateRef) return [];
      return Reflect.ownKeys(stateRef as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!stateRef) return undefined;
      return Reflect.getOwnPropertyDescriptor(stateRef as object, property);
    },
  });

  return definePackage({
    name: INTERACTIONS_PLUGIN_STATE_KEY,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth', 'slingshot-permissions'],
    entities: [interactionEventModule],
    capabilities: {
      provides: [
        // Always return the same long-lived `runtimeView` Proxy. The framework
        // calls `provider.resolve()` twice (once at `setupMiddleware`, once at
        // `setupPost`) and republishes the cap slot each time — returning a
        // single stable reference means consumers reading the cap at any
        // lifecycle phase observe `===` identity. Field access defers to the
        // live `stateRef` and throws a clear error if reached before
        // setupMiddleware has populated it.
        provideCapability(InteractionsRuntimeCap, () => runtimeView),
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

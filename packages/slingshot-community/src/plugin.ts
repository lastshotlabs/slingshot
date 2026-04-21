import type {
  ChannelIncomingEventDeclaration,
  NotificationRecord,
  NotificationsPeerState,
  PermissionsState,
  PluginSetupContext,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  PERMISSIONS_STATE_KEY,
  defineEvent,
  deepFreeze,
  getContextOrNull,
  getNotificationsStateOrNull,
  getPermissionsStateOrNull,
  getPluginStateOrNull,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { ChannelConfigDeps, EntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { notifyMentions } from './lib/mentions';
import type { NotifyMentionsDeps } from './lib/mentions';
import { communityManifest } from './manifest/communityManifest';
import { createCommunityManifestRuntime } from './manifest/runtime';
import { createBanNotifyMiddleware } from './middleware/banNotify';
import { createContainerCreationGuardMiddleware } from './middleware/containerCreationGuard';
import { createGrantManagerMiddleware } from './middleware/grantManager';
import { createMemberJoinGuardMiddleware } from './middleware/memberJoinGuard';
import { buildAttachmentRequiredGuard, buildPollRequiredGuard } from './middleware/peerGuards';
import { createReplyPostCreateMiddleware } from './middleware/replyPostCreate';
import { createThreadPostCreateMiddleware } from './middleware/threadPostCreate';
import { probePushFormatterRegistrar } from './peers/push';
import { DEFAULT_SCORING_CONFIG } from './types/config';
import type { CommunityPluginConfig } from './types/config';
import { communityPluginConfigSchema } from './types/config';
import type { CommunityInteractionsPeer, CommunityPluginState } from './types/state';
import { COMMUNITY_PLUGIN_STATE_KEY } from './types/state';

type AdapterResult = BareEntityAdapter;

function toNotificationText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
}

function notificationData(notification: NotificationRecord): Record<string, unknown> {
  return notification.data && typeof notification.data === 'object' ? notification.data : {};
}

/**
 * Build the interactions peer from live adapter references.
 *
 * Factored out of the plugin body to avoid duplicating the
 * `updateComponents` cast pattern between `setupMiddleware` and
 * `setupRoutes`.
 */
function buildInteractionsPeer(
  threadRef: () => AdapterResult | undefined,
  replyRef: () => AdapterResult | undefined,
): CommunityInteractionsPeer {
  return {
    peerKind: 'community',
    async resolveMessageByKindAndId(kind, id) {
      if (kind === 'community:thread') {
        return (await threadRef()?.getById(id)) ?? null;
      }
      if (kind === 'community:reply') {
        return (await replyRef()?.getById(id)) ?? null;
      }
      return null;
    },
    async updateComponents(kind, id, components) {
      if (kind === 'community:thread') {
        const adapter = threadRef() as
          | (AdapterResult & {
              updateComponents(
                match: { id: string },
                data: { components?: unknown },
              ): Promise<unknown>;
            })
          | undefined;
        await adapter?.updateComponents({ id }, { components });
        return;
      }
      if (kind === 'community:reply') {
        const adapter = replyRef() as
          | (AdapterResult & {
              updateComponents(
                match: { id: string },
                data: { components?: unknown },
              ): Promise<unknown>;
            })
          | undefined;
        await adapter?.updateComponents({ id }, { components });
      }
    },
  };
}

/**
 * Create the community plugin using the config-driven entity system.
 *
 * Wires all 8 community entities (Container, Thread, Reply, Reaction,
 * ContainerMember, ContainerRule, Report, Ban) through
 * `createEntityPlugin()`. No hand-written routes, no service layer — route
 * configuration on each entity drives auth, permissions, events, cascades,
 * and middleware.
 *
 * **Permissions resolution:** the plugin reads `PermissionsState` from
 * `ctx.pluginState` (keyed by `PERMISSIONS_STATE_KEY`), which is populated by
 * `createPermissionsPlugin()` during its `setupMiddleware` phase. Declare
 * `'slingshot-permissions'` before community so the framework guarantees
 * ordering.
 *
 * @param rawConfig - Plugin configuration. Validated against the Zod schema at
 *   construction time; throws if any required field is missing or mis-typed.
 * @returns A `SlingshotPlugin` suitable for passing to `createApp()`.
 *
 * @throws {Error} If `rawConfig` fails the Zod schema validation.
 * @throws {Error} If `PERMISSIONS_STATE_KEY` is absent from `ctx.pluginState`
 *   when `setupMiddleware` runs.
 *
 * @remarks
 * The plugin declares dependencies on `'slingshot-auth'`,
 * `'slingshot-notifications'`, and `'slingshot-permissions'`. Auth middleware must
 * therefore be registered before this plugin runs.
 *
 * Adapter-dependent middleware (banCheck, autoMod, threadStateGuard,
 * banNotify) is initialised lazily during `setupRoutes` after the corresponding
 * entity adapters are resolved. The middleware refs start as no-ops to satisfy
 * the middleware map type.
 *
 * **WebSocket self-wiring:** When `ws.wsEndpoint` is configured, the plugin
 * self-registers its `onRoomSubscribe` guard and `incoming` handlers onto
 * `SlingshotContext.wsEndpoints[wsEndpoint]` during `setupPost`. No caller-side
 * wiring of `buildSubscribeGuard` or `buildReceiveIncoming` is needed. In
 * manifest mode only `wsEndpoint` is required — WS publish/runtime access is
 * resolved lazily from `SlingshotContext`.
 *
 * @example
 * ```ts
 * import { createCommunityPlugin } from '@lastshotlabs/slingshot-community';
 *
 * // Manifest-compatible — permissions come from pluginState, WS self-wires:
 * const community = createCommunityPlugin({
 *   containerCreation: 'admin',
 *   ws: { wsEndpoint: 'community' },
 * });
 * ```
 */
/**
 * A community plugin with WebSocket channel helpers.
 *
 * Returned by `createCommunityPlugin()` when `ws` config is provided. Extends
 * `SlingshotPlugin` with `buildSubscribeGuard` and `buildReceiveIncoming` for
 * declarative WebSocket wiring.
 *
 * @example
 * ```ts
 * const community = createCommunityPlugin({ ..., ws: { wsEndpoint: 'community' } });
 *
 * // In app WS config:
 * endpoints: {
 *   community: {
 *     presence: true,
 *     onRoomSubscribe: community.buildSubscribeGuard(deps),
 *     incoming: community.buildReceiveIncoming(),
 *   }
 * }
 * ```
 */
export interface CommunityPlugin extends SlingshotPlugin {
  /**
   * Build the WebSocket subscribe guard for community channels.
   * Returns a no-op guard (`() => Promise<true>`) when the plugin is created without `ws` config.
   *
   * Wire into the WS endpoint's `onRoomSubscribe`.
   */
  buildSubscribeGuard(deps: ChannelConfigDeps): (ws: unknown, room: string) => Promise<boolean>;

  /**
   * Build the WebSocket incoming event handler map for community channels.
   * Returns `{}` when the plugin is created without `ws` config.
   *
   * Wire into the WS endpoint's `incoming`.
   */
  buildReceiveIncoming(): Record<string, ChannelIncomingEventDeclaration>;
}

export function createCommunityPlugin(rawConfig: CommunityPluginConfig): CommunityPlugin {
  const config = deepFreeze(
    validatePluginConfig(COMMUNITY_PLUGIN_STATE_KEY, rawConfig, communityPluginConfigSchema),
  );

  // ---------------------------------------------------------------------------
  // Lazy middleware refs — all start as no-ops.
  //
  // Adapter-dependent refs (banCheck, autoMod, threadStateGuard, banNotify) are
  // populated during setupRoutes once entity adapters are resolved.
  //
  // Permission-dependent refs (containerCreationGuard, grantManager) are
  // populated in setupMiddleware once permissions are resolved.
  // ---------------------------------------------------------------------------
  type LazyMiddleware = { handler: import('hono').MiddlewareHandler };
  const noop: import('hono').MiddlewareHandler = async (_c, next) => next();
  const banCheckRef: LazyMiddleware = { handler: noop };
  const autoModRef: LazyMiddleware = { handler: noop };
  const threadStateGuardRef: LazyMiddleware = { handler: noop };
  const banNotifyRef: LazyMiddleware = { handler: noop };
  const containerCreationGuardRef: LazyMiddleware = { handler: noop };
  const grantManagerRef: LazyMiddleware = { handler: noop };
  const replyCountUpdateRef: LazyMiddleware = { handler: noop };
  const replyCountDecrementRef: LazyMiddleware = { handler: noop };
  const auditLogRef: LazyMiddleware = { handler: noop };

  // Adapter references for setupPost event handlers.
  let threadAdapterRef: AdapterResult | undefined;
  let replyAdapterRef: AdapterResult | undefined;
  let memberAdapterRef: AdapterResult | undefined;
  let notificationsStateRef: NotificationsPeerState | undefined;

  // Inner entity plugin — created in setupMiddleware after permissions are resolved.
  let innerPlugin: EntityPlugin | undefined;

  // Permissions resolved in setupMiddleware — retained for setupPost WS self-wiring.
  let permissionsRef: PermissionsState | undefined;

  // Interactions peer — built once in setupMiddleware, reused in setupRoutes
  // for pluginState updates. Captures adapter refs by closure so it always
  // resolves against the latest adapters.
  const interactionsPeer = buildInteractionsPeer(
    () => threadAdapterRef,
    () => replyAdapterRef,
  );

  const scoringConfig = config.scoring ?? DEFAULT_SCORING_CONFIG;

  return {
    name: COMMUNITY_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth', 'slingshot-notifications', 'slingshot-permissions'],

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      if (!events.get('community:thread.embeds.resolved')) {
        events.register(
          defineEvent('community:thread.embeds.resolved', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                actorId: null,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }
      if (!events.get('community:reply.embeds.resolved')) {
        events.register(
          defineEvent('community:reply.embeds.resolved', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                actorId: null,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }
      if (!events.get('community:invite.redeemed')) {
        events.register(
          defineEvent('community:invite.redeemed', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                userId: payload.userId,
                actorId: payload.userId,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }

      // Auto-bridge auth context to community principal when configured.
      if (config.authBridge === 'auto') {
        const mountPath = config.mountPath ?? '/community';
        app.use(`${mountPath}/*`, async (c, next) => {
          const userId = c.get('authUserId');
          const rolesValue = c.get('roles');
          const roles = Array.isArray(rolesValue)
            ? rolesValue.filter((role): role is string => typeof role === 'string')
            : [];
          if (typeof userId === 'string') {
            // Opaque boundary: AppEnv doesn't include CommunityEnv variables.
            // The communityPrincipal context variable is consumed by community
            // routes which are typed with CommunityEnv.
            (c as unknown as { set(key: string, value: unknown): void }).set('communityPrincipal', {
              subject: userId,
              roles,
            });
          }
          await next();
        });
      }

      const pluginState = getPluginStateOrNull(app);
      const permissions: PermissionsState =
        getPermissionsStateOrNull(app) ??
        (() => {
          throw new Error(
            '[slingshot-community] No permissions available. Register createPermissionsPlugin() before this plugin.',
          );
        })();

      // Retain for setupPost WS self-wiring (buildSubscribeGuard needs permissions).
      permissionsRef = permissions;

      if (pluginState) {
        if (!pluginState.has(PERMISSIONS_STATE_KEY)) {
          pluginState.set(PERMISSIONS_STATE_KEY, permissions);
        }
        pluginState.set(COMMUNITY_PLUGIN_STATE_KEY, {
          config,
          evaluator: permissions.evaluator,
          interactionsPeer,
        } satisfies CommunityPluginState);
      }

      // Populate permission-dependent middleware refs now that permissions are resolved.
      containerCreationGuardRef.handler = createContainerCreationGuardMiddleware({
        containerCreation: config.containerCreation,
        permissionEvaluator: permissions.evaluator,
      });
      grantManagerRef.handler = createGrantManagerMiddleware({
        permissionsAdapter: permissions.adapter,
        getMemberById: async memberId => {
          const adapter = memberAdapterRef as
            | {
                getById(id: string): Promise<{
                  role?: string;
                  userId?: string;
                  containerId?: string;
                } | null>;
              }
            | undefined;
          if (!adapter) return null;
          return await adapter.getById(memberId);
        },
      });
      const memberJoinGuard = createMemberJoinGuardMiddleware();
      const manifest = structuredClone(communityManifest);
      const manifestRuntime = createCommunityManifestRuntime({
        scoring: scoringConfig,
        permissionsAdapter: permissions.adapter,
        onAdaptersCaptured: adapters => {
          threadAdapterRef = adapters.thread as unknown as AdapterResult;
          replyAdapterRef = adapters.reply as unknown as AdapterResult;
          memberAdapterRef = adapters.member as unknown as AdapterResult;
        },
        setBanCheckHandler(handler) {
          banCheckRef.handler = handler;
        },
        setAutoModHandler(handler) {
          autoModRef.handler = handler;
        },
        setThreadStateGuardHandler(handler) {
          threadStateGuardRef.handler = handler;
        },
        setReplyCountUpdateHandler(handler) {
          replyCountUpdateRef.handler = handler;
        },
        setReplyCountDecrementHandler(handler) {
          replyCountDecrementRef.handler = handler;
        },
        setAuditLogHandler(handler) {
          auditLogRef.handler = handler;
        },
      });

      // Build the inner entity plugin with fully-resolved permissions.
      innerPlugin = createEntityPlugin({
        name: COMMUNITY_PLUGIN_STATE_KEY,
        mountPath: config.mountPath ?? '/community',
        manifest,
        manifestRuntime,

        // Wire WS config when provided.
        wsEndpoint: config.ws?.wsEndpoint,

        middleware: {
          banCheck: async (c, next) => banCheckRef.handler(c, next),
          autoMod: async (c, next) => autoModRef.handler(c, next),
          threadStateGuard: async (c, next) => threadStateGuardRef.handler(c, next),
          auditLog: async (c, next) => auditLogRef.handler(c, next),
          grantManager: async (c, next) => grantManagerRef.handler(c, next),
          containerCreationGuard: async (c, next) => containerCreationGuardRef.handler(c, next),
          banNotify: async (c, next) => banNotifyRef.handler(c, next),
          memberJoinGuard,
          pollRequiredGuard: buildPollRequiredGuard(app),
          attachmentRequiredGuard: buildAttachmentRequiredGuard(app),
          threadPostCreate: createThreadPostCreateMiddleware(),
          replyPostCreate: createReplyPostCreateMiddleware(),
          replyCountUpdate: async (c, next) => replyCountUpdateRef.handler(c, next),
          replyCountDecrement: async (c, next) => replyCountDecrementRef.handler(c, next),
        },

        permissions,

        setupPost: ({ bus: postBus }) => {
          const notificationBuilder = notificationsStateRef?.createBuilder({ source: 'community' });
          if (!notificationBuilder) return;
          const builder = notificationBuilder;

          banNotifyRef.handler = createBanNotifyMiddleware({
            builder,
          });

          type DynamicBus = {
            on(
              event: string,
              handler: (payload: Record<string, unknown>) => void | Promise<void>,
            ): void;
          };
          const dynamicBus = postBus as unknown as DynamicBus;

          dynamicBus.on('community:reply.created', async payload => {
            const replyId = (payload.id ?? payload.replyId) as string | undefined;
            const actorId = payload.authorId as string | undefined;
            const threadId = payload.threadId as string | undefined;
            if (!replyId || !actorId || !threadId || !threadAdapterRef) return;

            const thread = (await threadAdapterRef.getById(threadId)) as {
              authorId?: string;
              containerId?: string;
            } | null;
            if (!thread?.authorId || !thread.containerId) return;

            await notificationBuilder.notify({
              tenantId: payload.tenantId as string | undefined,
              userId: thread.authorId,
              type: 'community:reply',
              actorId,
              targetType: 'community:reply',
              targetId: replyId,
              scopeId: thread.containerId,
              dedupKey: `community:reply:${threadId}:${thread.authorId}`,
              data: {
                threadId,
                containerId: thread.containerId,
              },
            });
          });

          function buildMentionDeps(): NotifyMentionsDeps | null {
            if (!threadAdapterRef || !replyAdapterRef) return null;
            return {
              builder,
              threadAdapter: threadAdapterRef as unknown as NotifyMentionsDeps['threadAdapter'],
              replyAdapter: replyAdapterRef as unknown as NotifyMentionsDeps['replyAdapter'],
            };
          }

          dynamicBus.on('community:thread.created', async payload => {
            const deps = buildMentionDeps();
            if (!deps) return;
            await notifyMentions(payload, deps, 'thread');
          });

          dynamicBus.on('community:reply.created', async payload => {
            const deps = buildMentionDeps();
            if (!deps) return;
            await notifyMentions(payload, deps, 'reply');
          });
        },
      });

      if (innerPlugin.setupMiddleware) {
        await innerPlugin.setupMiddleware({ app, config: frameworkConfig, bus, events });
      }
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      const pluginState = getPluginStateOrNull(app);
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      if (permissionsRef && pluginState) {
        if (!pluginState.has(PERMISSIONS_STATE_KEY)) {
          pluginState.set(PERMISSIONS_STATE_KEY, permissionsRef);
        }
        pluginState.set(COMMUNITY_PLUGIN_STATE_KEY, {
          config,
          evaluator: permissionsRef.evaluator,
          interactionsPeer,
        } satisfies CommunityPluginState);
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      const appCtx = getContextOrNull(app);
      const pluginState = getPluginStateOrNull(app);
      notificationsStateRef ??= getNotificationsStateOrNull(pluginState) ?? undefined;
      if (!notificationsStateRef) {
        throw new Error(
          '[slingshot-community] slingshot-notifications is a required dependency. ' +
            'Register createNotificationsPlugin() before this plugin.',
        );
      }
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      // Push formatter registration — optional integration with slingshot-push.
      // Duck-typed to avoid a direct dependency on @lastshotlabs/slingshot-push.
      // If slingshot-push is present, community registers formatters for each
      // notification type it emits so push delivery produces meaningful titles/bodies.
      const maybePushState = probePushFormatterRegistrar(pluginState);

      if (maybePushState) {
        const truncate = (text: unknown, max = 100): string => {
          const str = typeof text === 'string' ? text : '';
          return str.length <= max ? str : `${str.slice(0, max)}\u2026`;
        };

        maybePushState.registerFormatter('community:reply', n => {
          const data = notificationData(n);
          return {
            title: `${toNotificationText(data['actorName'], 'Someone')} replied to your thread`,
            body: truncate(data['threadTitle']),
            url: `/community/threads/${toNotificationText(data['threadId'])}#reply-${toNotificationText(data['replyId'])}`,
          };
        });

        maybePushState.registerFormatter('community:mention', n => {
          const data = notificationData(n);
          const replyId = toNotificationText(data['replyId']);
          return {
            title: `${toNotificationText(data['actorName'], 'Someone')} mentioned you`,
            body: truncate(data['bodyPreview']),
            url: `/community/threads/${toNotificationText(data['threadId'])}${replyId !== '' ? `#reply-${replyId}` : ''}`,
          };
        });

        maybePushState.registerFormatter('community:ban', n => {
          const data = notificationData(n);
          const containerId = toNotificationText(data['containerId']);
          return {
            title:
              containerId !== '' ? 'You have been banned from a container' : 'You have been banned',
            body: toNotificationText(data['reason'], 'Contact a moderator for details.'),
            url: `/community/containers/${containerId}`,
          };
        });

        maybePushState.registerFormatter('community:warning', n => {
          const data = notificationData(n);
          return {
            title: 'Moderator warning',
            body: toNotificationText(data['reason']),
            url: `/community/containers/${toNotificationText(data['containerId'])}`,
          };
        });

        maybePushState.registerFormatter('community:thread.subscribed_reply', n => {
          const data = notificationData(n);
          return {
            title: `New reply in \u201c${toNotificationText(data['threadTitle'], 'a thread')}\u201d`,
            body: truncate(data['bodyPreview']),
            url: `/community/threads/${toNotificationText(data['threadId'])}#reply-${toNotificationText(data['replyId'])}`,
          };
        });
      }

      // Self-wire WS subscribe guard and incoming handlers onto the live endpoint
      // config. This runs after all adapters are resolved and innerPlugin is fully
      // initialised, so buildSubscribeGuard and buildReceiveIncoming are available.
      //
      // In manifest mode: ctx.wsEndpoints is populated by the framework before
      // plugins run, so mutations here are visible when connections arrive.
      // In code mode: callers may instead use buildSubscribeGuard/buildReceiveIncoming
      // directly when constructing the WS endpoint config.
      if (config.ws?.wsEndpoint && innerPlugin && permissionsRef) {
        const endpointMap = appCtx?.wsEndpoints;
        if (endpointMap) {
          const ep = (endpointMap[config.ws.wsEndpoint] ??= {});
          ep.onRoomSubscribe = innerPlugin.buildSubscribeGuard({
            getIdentity: (ws: unknown) => {
              const data = (ws as { data?: { userId?: string } }).data;
              return data?.userId ? { userId: data.userId } : null;
            },
            checkPermission: (userId, requires, scope) => {
              if (!permissionsRef) return Promise.resolve(false);
              return permissionsRef.evaluator.can(
                { subjectId: userId, subjectType: 'user' },
                requires,
                scope,
              );
            },
            middleware: {},
          });
          const incoming = innerPlugin.buildReceiveIncoming();
          ep.incoming = { ...ep.incoming, ...incoming };
        }
      }
    },

    buildSubscribeGuard(deps: ChannelConfigDeps): (ws: unknown, room: string) => Promise<boolean> {
      if (!innerPlugin) {
        // Called before setupMiddleware — return a no-op guard.
        return () => Promise.resolve(true);
      }
      return innerPlugin.buildSubscribeGuard(deps);
    },

    buildReceiveIncoming(): Record<string, ChannelIncomingEventDeclaration> {
      if (!innerPlugin) return {};
      return innerPlugin.buildReceiveIncoming();
    },
  };
}

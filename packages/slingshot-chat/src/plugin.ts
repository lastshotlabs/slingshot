import type { MiddlewareHandler } from 'hono';
import type {
  PermissionsState,
  PluginSetupContext,
  SlingshotPlugin,
  WsPluginEndpoint,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  defineEvent,
  getContext,
  getPluginState,
  parseBody,
  provideCapability,
  publishPluginState,
  registerPluginCapabilities,
  resolveCapabilityValue,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { NotificationsBuilderFactory } from '@lastshotlabs/slingshot-notifications';
import { ChatInteractionsPeerCap } from './public';
import type { ChatInteractionsPeer } from './public';
import {
  PermissionsAdapterCap,
  PermissionsEvaluatorCap,
  PermissionsRegistryCap,
} from '@lastshotlabs/slingshot-permissions';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { chatPluginConfigSchema } from './config.schema';
import { resolveChatEncryptionProvider } from './encryption/provider';
import { buildEncryptionRouter } from './encryption/stub';
import type { ChatEncryptionProvider } from './encryption/types';
import { registerChatPushFormatters } from './lib/pushFormatters';
import { chatManifest } from './manifest/chatManifest';
import { createChatManifestRuntime } from './manifest/runtime';
import { createArchiveGuardMiddleware } from './middleware/archiveGuard';
import { createBroadcastGuardMiddleware } from './middleware/broadcastGuard';
import { createDmRoomGuardMiddleware } from './middleware/dmRoomGuard';
import { createMemberGrantMiddleware } from './middleware/memberGrant';
import { createMemberInviteNotifyMiddleware } from './middleware/memberInviteNotify';
import { createMessageNotifyMiddleware } from './middleware/messageNotify';
import { createMessagePostCreateMiddleware } from './middleware/messagePostCreate';
import { buildAttachmentRequiredGuard, buildPollRequiredGuard } from './middleware/peerGuards';
import { createReplyCountDecrementMiddleware } from './middleware/replyCountDecrement';
import { createReplyCountUpdateMiddleware } from './middleware/replyCountUpdate';
import { createRoomCreatorGrantMiddleware } from './middleware/roomCreatorGrant';
import { probeEmbedsPeer } from './peers/embeds';
import { probePushFormatterRegistry } from './peers/push';
import { CHAT_PLUGIN_STATE_KEY, CHAT_RUNTIME_KEY } from './state';
import type { Message as ChatMessage, ChatPluginConfig, ChatPluginState } from './types';
import { buildIncomingDispatch } from './ws/incoming';

/**
 * Create the slingshot-chat plugin using the manifest-driven entity system.
 *
 * Persists rooms, memberships, messages, reactions, read receipts, pins, blocks,
 * favorites, invites, and reminders through `createEntityPlugin({ manifest })`.
 * DM orchestration, unread counts, scheduled-message claims, message reminder
 * claims, and message encryption are resolved through the chat manifest runtime.
 *
 * **Permissions resolution:** the plugin resolves the evaluator, registry, and
 * adapter through `ctx.capabilities.require(PermissionsEvaluatorCap)` (and the
 * matching registry/adapter caps) in `setupMiddleware`. Declare
 * `'slingshot-permissions'` before chat so the framework topological sort
 * guarantees ordering.
 *
 * **Notifications resolution:** the plugin resolves the notifications builder
 * factory through `ctx.capabilities.require(NotificationsBuilderFactory)` in
 * `setupMiddleware` and uses it to emit `chat:message` and `chat:invite`
 * notifications.
 *
 * **Public contract:** the plugin publishes `ChatInteractionsPeerCap` (the
 * `Chat` package contract handle) so cross-package consumers — notably
 * `slingshot-interactions` for component-tree resolution — can resolve the peer
 * via `ctx.capabilities.require(ChatInteractionsPeerCap)` instead of reaching
 * into plugin state. The plugin also continues to write `interactionsPeer` into
 * `pluginState` under `CHAT_PLUGIN_STATE_KEY` so legacy
 * `getPublishedInteractionsPeerOrNull` consumers keep working. The full chat
 * runtime — the bundled adapter set, evaluator, and config — is published
 * separately under `CHAT_RUNTIME_KEY` for in-package consumers.
 *
 * @param rawConfig - Plugin configuration. Validated with Zod at construction
 *   time; throws if any required field is missing or mis-typed.
 * @returns A `SlingshotPlugin` ready to pass to `createApp({ plugins: [...] })`.
 *
 * @throws {Error} If `rawConfig` fails the Zod schema validation.
 * @throws {Error} If `slingshot-permissions` is not registered before chat —
 *   the evaluator/registry/adapter capabilities are required during
 *   `setupMiddleware`.
 * @throws {Error} If `slingshot-notifications` is not registered before chat —
 *   the notifications builder factory is required during `setupMiddleware`.
 *
 * @remarks
 * The plugin declares dependencies on `'slingshot-auth'`,
 * `'slingshot-notifications'`, and `'slingshot-permissions'`.
 *
 * **WebSocket self-wiring:** chat self-registers its incoming event handlers
 * onto `SlingshotContext.wsEndpoints[mountPath]` during `setupPost`. No
 * caller-side wiring is required.
 *
 * **Background schedulers:** during `setupPost` the plugin starts two 30-second
 * intervals — one for due reminders, one for scheduled message delivery. Both
 * are cleared in `teardown()`.
 *
 * **Optional peer integrations:** chat opportunistically integrates with
 * `slingshot-push` (formatter registration) and `slingshot-embeds` (URL unfurl
 * on new messages) when those plugins are present. Both integrations are
 * duck-typed — chat does not import them.
 *
 * @example
 * ```ts
 * import { createChatPlugin } from '@lastshotlabs/slingshot-chat';
 *
 * const chat = createChatPlugin({
 *   storeType: 'postgres',
 *   mountPath: '/chat',
 *   enablePresence: true,
 * });
 * ```
 */
export function createChatPlugin(rawConfig: ChatPluginConfig): SlingshotPlugin {
  const config: Readonly<ChatPluginConfig> = deepFreeze(
    validatePluginConfig(CHAT_PLUGIN_STATE_KEY, rawConfig, chatPluginConfigSchema),
  );
  const tenantId = config.tenantId ?? 'default';
  const mountPath = config.mountPath ?? '/chat';
  const encryptionProvider: ChatEncryptionProvider | null = resolveChatEncryptionProvider(
    config.encryption,
  );

  type LazyMiddleware = { handler: MiddlewareHandler };
  const noop: MiddlewareHandler = async (_c, next_) => next_();
  const archiveGuardRef: LazyMiddleware = { handler: noop };
  const broadcastGuardRef: LazyMiddleware = { handler: noop };
  const dmRoomGuardRef: LazyMiddleware = { handler: noop };
  const roomCreatorGrantRef: LazyMiddleware = { handler: noop };
  const memberGrantRef: LazyMiddleware = { handler: noop };
  const messagePostCreateRef: LazyMiddleware = { handler: noop };
  const messageNotifyRef: LazyMiddleware = { handler: noop };
  const memberInviteNotifyRef: LazyMiddleware = { handler: noop };
  const replyCountUpdateRef: LazyMiddleware = { handler: noop };
  const replyCountDecrementRef: LazyMiddleware = { handler: noop };

  let roomAdapterRef: ChatPluginState['rooms'] | undefined;
  let memberAdapterRef: ChatPluginState['members'] | undefined;
  let messageAdapterRef: ChatPluginState['messages'] | undefined;
  let receiptAdapterRef: ChatPluginState['receipts'] | undefined;
  let reactionAdapterRef: ChatPluginState['reactions'] | undefined;
  let blockAdapterRef: ChatPluginState['blocks'] | undefined;
  let pinAdapterRef: ChatPluginState['pins'] | undefined;
  let favoriteAdapterRef: ChatPluginState['favorites'] | undefined;
  let inviteAdapterRef: ChatPluginState['invites'] | undefined;
  let reminderAdapterRef: ChatPluginState['reminders'] | undefined;

  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  let scheduledTimer: ReturnType<typeof setInterval> | undefined;
  let innerPlugin: EntityPlugin | undefined;
  let permissionsRef: PermissionsState | undefined;
  let notificationsBuilderFactoryRef:
    | ((opts: { source: string }) => import('@lastshotlabs/slingshot-core').NotificationBuilder)
    | undefined;

  // Interactions peer — built once at plugin construction so the lifecycle
  // phases and the capability publish all share one instance. Closes over
  // `messageAdapterRef` so it always sees the latest adapter reference.
  const interactionsPeer: ChatInteractionsPeer = {
    peerKind: 'chat',
    async resolveMessageByKindAndId(kind, id) {
      if (kind !== 'chat:message') return null;
      return (await messageAdapterRef?.getById(id)) ?? null;
    },
    async updateComponents(kind, id, components) {
      if (kind !== 'chat:message' || !messageAdapterRef) return;
      await messageAdapterRef.updateComponents({ id }, { components });
    },
  };

  return {
    name: CHAT_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth', 'slingshot-notifications', 'slingshot-permissions'],

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      if (!events.get('chat:message.embeds.resolved')) {
        events.register(
          defineEvent('chat:message.embeds.resolved', {
            ownerPlugin: CHAT_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                userId: null,
                actorId: null,
                resourceType: 'chat:room',
                resourceId: payload.roomId,
              };
            },
          }),
        );
      }
      if (!events.get('chat:message.scheduled.created')) {
        events.register(
          defineEvent('chat:message.scheduled.created', {
            ownerPlugin: CHAT_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                userId: payload.authorId ?? null,
                actorId: payload.authorId ?? null,
                resourceType: 'chat:room',
                resourceId: payload.roomId,
              };
            },
          }),
        );
      }
      if (!events.get('chat:message.scheduled.delivered')) {
        events.register(
          defineEvent('chat:message.scheduled.delivered', {
            ownerPlugin: CHAT_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                userId: payload.authorId ?? null,
                actorId: null,
                resourceType: 'chat:room',
                resourceId: payload.roomId,
              };
            },
          }),
        );
      }

      const slingshotCtx = getContext(app);
      const evaluator = resolveCapabilityValue(slingshotCtx, PermissionsEvaluatorCap);
      const registry = resolveCapabilityValue(slingshotCtx, PermissionsRegistryCap);
      const adapter = resolveCapabilityValue(slingshotCtx, PermissionsAdapterCap);
      if (!evaluator || !registry || !adapter) {
        throw new Error(
          '[slingshot-chat] requires slingshot-permissions to be loaded before slingshot-chat',
        );
      }
      const permissions: PermissionsState = { evaluator, registry, adapter };
      // `NotificationsBuilderFactory` is published by `slingshot-notifications`
      // in its `setupPost` phase, which runs AFTER every plugin's `setupMiddleware`.
      // We can't resolve it here. Defer to chat's own `setupPost` where the
      // capability is guaranteed to be available, and where the inner entity
      // plugin's `setupPost` (which actually consumes the factory) runs.
      permissionsRef = permissions;

      publishPluginState(getPluginState(app), CHAT_PLUGIN_STATE_KEY, {
        interactionsPeer,
      } satisfies Pick<ChatPluginState, 'interactionsPeer'>);

      memberGrantRef.handler = createMemberGrantMiddleware({
        permissionsAdapter: permissions.adapter,
        tenantId,
      });

      const manifest = structuredClone(chatManifest);
      if (manifest.entities.Room.channels?.channels.live) {
        manifest.entities.Room.channels.channels.live.presence = config.enablePresence ?? true;
      }

      const manifestRuntime = createChatManifestRuntime({
        tenantId,
        permissions,
        encryptionProvider,
        setAdapters(adapters) {
          roomAdapterRef = adapters.rooms;
          memberAdapterRef = adapters.members;
          messageAdapterRef = adapters.messages;
          receiptAdapterRef = adapters.receipts;
          reactionAdapterRef = adapters.reactions;
          pinAdapterRef = adapters.pins;
          blockAdapterRef = adapters.blocks;
          favoriteAdapterRef = adapters.favorites;
          inviteAdapterRef = adapters.invites;
          reminderAdapterRef = adapters.reminders;

          archiveGuardRef.handler = createArchiveGuardMiddleware({
            roomAdapter: adapters.rooms,
          });
          broadcastGuardRef.handler = createBroadcastGuardMiddleware({
            roomAdapter: adapters.rooms,
            evaluator: permissions.evaluator,
            tenantId,
          });
          dmRoomGuardRef.handler = createDmRoomGuardMiddleware({
            roomAdapter: adapters.rooms,
          });
          roomCreatorGrantRef.handler = createRoomCreatorGrantMiddleware({
            memberAdapter: adapters.members,
            permissionsAdapter: permissions.adapter,
            tenantId,
          });
          messagePostCreateRef.handler = createMessagePostCreateMiddleware({
            roomAdapter: adapters.rooms,
            permissionsAdapter: permissions.adapter,
            tenantId,
          });
          replyCountUpdateRef.handler = createReplyCountUpdateMiddleware({
            messageAdapter: adapters.messages,
          });
          replyCountDecrementRef.handler = createReplyCountDecrementMiddleware({
            messageAdapter: adapters.messages,
          });
        },
      });

      innerPlugin = createEntityPlugin({
        name: CHAT_PLUGIN_STATE_KEY,
        mountPath,
        manifest,
        manifestRuntime,
        wsEndpoint: mountPath,
        middleware: {
          archiveGuard: async (c, next) => archiveGuardRef.handler(c, next),
          broadcastGuard: async (c, next) => broadcastGuardRef.handler(c, next),
          dmRoomGuard: async (c, next) => dmRoomGuardRef.handler(c, next),
          roomCreatorGrant: async (c, next) => roomCreatorGrantRef.handler(c, next),
          memberGrant: async (c, next) => memberGrantRef.handler(c, next),
          messagePostCreate: async (c, next) => messagePostCreateRef.handler(c, next),
          messageNotify: async (c, next) => messageNotifyRef.handler(c, next),
          memberInviteNotify: async (c, next) => memberInviteNotifyRef.handler(c, next),
          replyCountUpdate: async (c, next) => replyCountUpdateRef.handler(c, next),
          replyCountDecrement: async (c, next) => replyCountDecrementRef.handler(c, next),
          pollRequiredGuard: buildPollRequiredGuard(app),
          attachmentRequiredGuard: buildAttachmentRequiredGuard(app),
        },
        permissions,
        setupPost: ({ bus: postBus }) => {
          if (notificationsBuilderFactoryRef && roomAdapterRef && memberAdapterRef && messageAdapterRef) {
            const notificationBuilder = notificationsBuilderFactoryRef({ source: 'chat' });
            messageNotifyRef.handler = createMessageNotifyMiddleware({
              builder: notificationBuilder,
              roomAdapter: roomAdapterRef,
              memberAdapter: memberAdapterRef,
              messageAdapter: messageAdapterRef,
            });
            memberInviteNotifyRef.handler = createMemberInviteNotifyMiddleware({
              builder: notificationBuilder,
              roomAdapter: roomAdapterRef,
            });
          }

          const pushState = probePushFormatterRegistry(app);
          if (pushState) {
            registerChatPushFormatters(pushState);
          }

          // parseBody → attachMentions: server-truth normalization of the
          // body's mention tokens into the message's `mentions` /
          // `broadcastMentions` / `mentionedRoleIds` sidecars. Closes the
          // spoofing gap where a client could set those arrays to
          // arbitrary user IDs. Failures are silent — sidecar
          // normalization is best-effort and must never break send.
          if (messageAdapterRef) {
            const msgAdapter = messageAdapterRef;
            postBus.on('chat:message.created', async (payload: Record<string, unknown>) => {
              const id = typeof payload.id === 'string' ? payload.id : undefined;
              if (!id) return;
              const record = (await msgAdapter.getById(id)) as
                | { body?: string; format?: 'plain' | 'markdown' }
                | null;
              if (!record) return;
              const parsed = parseBody(record.body, record.format ?? 'markdown');
              try {
                await msgAdapter.attachMentions(
                  { id },
                  {
                    mentions: parsed.mentions,
                    broadcastMentions: parsed.broadcastMentions,
                    mentionedRoleIds: parsed.mentionedRoleIds,
                  },
                );
              } catch {
                // Silent — best-effort normalization.
              }
            });
          }

          const embedsState = probeEmbedsPeer(app);
          if (embedsState && messageAdapterRef) {
            const msgAdapter = messageAdapterRef;
            postBus.on('chat:message.created', async (payload: Record<string, unknown>) => {
              const { extractUrls } = await import('./lib/urls');
              const msgId = payload.id as string | undefined;
              const body = payload.body as string | undefined;
              if (!msgId) return;
              const roomId = typeof payload.roomId === 'string' ? payload.roomId : undefined;
              if (!roomId) return;
              const urls = extractUrls(body);
              if (urls.length === 0) return;
              try {
                const embeds = await embedsState.unfurl(urls);
                if (embeds.length > 0) {
                  await msgAdapter.attachEmbeds({ id: msgId }, { embeds });
                  events.publish(
                    'chat:message.embeds.resolved',
                    {
                      id: msgId,
                      roomId,
                      embeds: embeds as NonNullable<ChatMessage['embeds']>,
                    },
                    {
                      source: 'system',
                      userId: typeof payload.authorId === 'string' ? payload.authorId : null,
                      // System-source emission with no originating HTTP request — no
                      // request-tenant exists. Set explicitly so downstream consumers
                      // can distinguish "absent" from "unknown".
                      requestTenantId: null,
                    },
                  );
                }
              } catch {
                // Silent skip - embed failures should not break messaging.
              }
            });
          }

          if (reminderAdapterRef) {
            const remAdapter = reminderAdapterRef;
            let reminderProcessing = false;
            reminderTimer = setInterval(async () => {
              if (reminderProcessing) return;
              reminderProcessing = true;
              try {
                const claimed = await remAdapter.claimDueReminders({ limit: 100 });
                for (const reminder of claimed) {
                  postBus.emit('chat:reminder.triggered', {
                    id: reminder.id,
                    userId: reminder.userId,
                    roomId: reminder.roomId,
                    messageId: reminder.messageId,
                    note: reminder.note,
                  });
                }
              } catch {
                // Silent - scheduler failures should not crash the process.
              } finally {
                reminderProcessing = false;
              }
            }, 30_000);
          }

          if (messageAdapterRef && roomAdapterRef) {
            const msgAdapter = messageAdapterRef;
            const rmAdapter = roomAdapterRef;
            let scheduledProcessing = false;
            scheduledTimer = setInterval(async () => {
              if (scheduledProcessing) return;
              scheduledProcessing = true;
              try {
                const claimed = await msgAdapter.claimDueScheduledMessages({ limit: 100 });
                for (const msg of claimed) {
                  events.publish('chat:message.scheduled.delivered', msg, {
                    source: 'system',
                    userId: msg.authorId ?? null,
                    // System-source scheduler — no originating HTTP request.
                    requestTenantId: null,
                  });
                  await rmAdapter
                    .updateLastMessage(
                      { id: msg.roomId },
                      { lastMessageAt: msg.createdAt, lastMessageId: msg.id },
                    )
                    .catch((err: unknown) => {
                      const message = err instanceof Error ? err.message : String(err);
                      console.warn(
                        `[slingshot-chat] Failed to update lastMessage for room ${msg.roomId}: ${message}`,
                      );
                    });
                }
              } catch {
                // Silent - scheduler failures should not crash the process.
              } finally {
                scheduledProcessing = false;
              }
            }, 30_000);
          }

          const chatState = getPluginState(app).get(CHAT_PLUGIN_STATE_KEY) as
            | ChatPluginState
            | undefined;
          if (!chatState) return;

          const incomingHandlers = buildIncomingDispatch(chatState, postBus);
          const endpointMap = getContext(app).wsEndpoints as Record<
            string,
            WsPluginEndpoint | undefined
          >;
          const endpoint = (endpointMap[mountPath] ??= {});
          const incoming: NonNullable<typeof endpoint.incoming> =
            endpoint.incoming === undefined ? {} : { ...endpoint.incoming };
          for (const handler of incomingHandlers) {
            incoming[handler.event] = {
              auth: handler.event === 'chat.ping' ? 'none' : 'userAuth',
              handler: async (ws, payload, context) => {
                let ackResult: unknown = null;

                await handler.handler({
                  actorId: context.actor.id ?? '',
                  socketId: context.socketId,
                  roomId:
                    typeof payload === 'object' &&
                    payload !== null &&
                    typeof (payload as { roomId?: unknown }).roomId === 'string'
                      ? (payload as { roomId: string }).roomId
                      : '',
                  payload,
                  ack(data) {
                    ackResult = data;
                  },
                  publish(room, event, data, opts) {
                    const eventPayload =
                      typeof data === 'object' && data !== null && !Array.isArray(data)
                        ? { event, ...(data as Record<string, unknown>) }
                        : { event, data };
                    const appCtx = getContext(app);
                    if (appCtx.ws && appCtx.wsPublish) {
                      appCtx.wsPublish(appCtx.ws, mountPath, room, eventPayload, {
                        exclude: opts?.exclude,
                        volatile: opts?.volatile,
                      });
                      return;
                    }
                    context.publish(room, eventPayload);
                  },
                });

                return ackResult;
              },
            };
          }
          endpoint.incoming = incoming;
        },
      });

      await innerPlugin.setupMiddleware?.({ app, config: frameworkConfig, bus, events });
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      if (
        roomAdapterRef &&
        memberAdapterRef &&
        messageAdapterRef &&
        receiptAdapterRef &&
        reactionAdapterRef &&
        pinAdapterRef &&
        blockAdapterRef &&
        favoriteAdapterRef &&
        permissionsRef
      ) {
        const chatState: ChatPluginState = {
          rooms: roomAdapterRef,
          members: memberAdapterRef,
          messages: messageAdapterRef,
          receipts: receiptAdapterRef,
          reactions: reactionAdapterRef,
          pins: pinAdapterRef,
          blocks: blockAdapterRef,
          favorites: favoriteAdapterRef,
          invites: inviteAdapterRef,
          reminders: reminderAdapterRef,
          config,
          interactionsPeer,
          evaluator: permissionsRef.evaluator,
        };
        publishPluginState(getPluginState(app), CHAT_RUNTIME_KEY, chatState);
        app.route(`${mountPath}/encryption`, buildEncryptionRouter(chatState));
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      // Resolve the notifications builder factory now that `slingshot-notifications`
      // has had its own `setupPost` run and published the capability. The inner
      // entity plugin's `setupPost` (called below) closes over
      // `notificationsBuilderFactoryRef` and uses it to wire the chat-message
      // notify middleware — so this assignment must happen BEFORE that delegation.
      const slingshotCtx = getContext(app);
      const notificationsBuilderFactory = resolveCapabilityValue(
        slingshotCtx,
        NotificationsBuilderFactory,
      );
      if (!notificationsBuilderFactory) {
        throw new Error(
          '[slingshot-chat] requires slingshot-notifications to be loaded before slingshot-chat',
        );
      }
      notificationsBuilderFactoryRef = notificationsBuilderFactory;

      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      // Contract-bound capability publish. The peer closure captures
      // `messageAdapterRef` so it always sees the latest adapter.
      // `interactionsPeer` is also written into pluginState above so legacy
      // `getPublishedInteractionsPeerOrNull` consumers keep working.
      await registerPluginCapabilities(getContext(app), 'slingshot-chat', [
        provideCapability(ChatInteractionsPeerCap, () => interactionsPeer),
      ]);
    },

    teardown() {
      if (reminderTimer) {
        clearInterval(reminderTimer);
        reminderTimer = undefined;
      }
      if (scheduledTimer) {
        clearInterval(scheduledTimer);
        scheduledTimer = undefined;
      }
    },
  };
}

import type { MiddlewareHandler } from 'hono';
import type {
  NotificationsPeerState,
  PermissionsState,
  PluginSetupContext,
  SlingshotPlugin,
  WsPluginEndpoint,
} from '@lastshotlabs/slingshot-core';
import {
  defineEvent,
  deepFreeze,
  getContext,
  getNotificationsState,
  getPermissionsState,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
import { chatPluginConfigSchema } from './config.schema';
import type { ChatEncryptionProvider } from './encryption/types';
import { resolveChatEncryptionProvider } from './encryption/provider';
import { buildEncryptionRouter } from './encryption/stub';
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
import { CHAT_PLUGIN_STATE_KEY } from './state';
import type { Message as ChatMessage, ChatPluginConfig, ChatPluginState } from './types';
import { buildIncomingDispatch } from './ws/incoming';

/**
 * Create the slingshot-chat plugin using the manifest-driven entity system.
 *
 * Persists rooms, memberships, messages, reactions, receipts, pins, blocks,
 * favorites, invites, and reminders through `createEntityPlugin({ manifest })`.
 * DM orchestration, unread counts, scheduler claims, and message encryption are
 * resolved through the chat manifest runtime.
 *
 * @param rawConfig - Plugin configuration. Validated with Zod at construction time.
 * @returns A `SlingshotPlugin` ready to pass to `createApp({ plugins: [...] })`.
 *
 * @throws {Error} If `slingshot-permissions` is not registered before chat.
 * @throws {Error} If `slingshot-notifications` is not registered before chat.
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
  let notificationsStateRef: NotificationsPeerState | undefined;

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

      const permissions = getPermissionsState(app) as PermissionsState;
      notificationsStateRef = getNotificationsState(app) as NotificationsPeerState;
      permissionsRef = permissions;

      getPluginState(app).set(CHAT_PLUGIN_STATE_KEY, {
        interactionsPeer: {
          peerKind: 'chat',
          async resolveMessageByKindAndId(kind, id) {
            if (kind !== 'chat:message') return null;
            return (await messageAdapterRef?.getById(id)) ?? null;
          },
          async updateComponents(kind, id, components) {
            if (kind !== 'chat:message' || !messageAdapterRef) return;
            await messageAdapterRef.updateComponents({ id }, { components });
          },
        },
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
          if (notificationsStateRef && roomAdapterRef && memberAdapterRef && messageAdapterRef) {
            const notificationBuilder = notificationsStateRef.createBuilder({ source: 'chat' });
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
            reminderTimer = setInterval(async () => {
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
              }
            }, 30_000);
          }

          if (messageAdapterRef && roomAdapterRef) {
            const msgAdapter = messageAdapterRef;
            const rmAdapter = roomAdapterRef;
            scheduledTimer = setInterval(async () => {
              try {
                const claimed = await msgAdapter.claimDueScheduledMessages({ limit: 100 });
                for (const msg of claimed) {
                  events.publish('chat:message.scheduled.delivered', msg, {
                    source: 'system',
                    userId: msg.authorId ?? null,
                  });
                  await rmAdapter
                    .updateLastMessage(
                      { id: msg.roomId },
                      { lastMessageAt: msg.createdAt, lastMessageId: msg.id },
                    )
                    .catch(() => {});
                }
              } catch {
                // Silent - scheduler failures should not crash the process.
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
                  userId: context.userId ?? '',
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
        const messageAdapter = messageAdapterRef;
        const chatState: ChatPluginState = {
          rooms: roomAdapterRef,
          members: memberAdapterRef,
          messages: messageAdapter,
          receipts: receiptAdapterRef,
          reactions: reactionAdapterRef,
          pins: pinAdapterRef,
          blocks: blockAdapterRef,
          favorites: favoriteAdapterRef,
          invites: inviteAdapterRef,
          reminders: reminderAdapterRef,
          config,
          interactionsPeer: {
            peerKind: 'chat',
            async resolveMessageByKindAndId(kind, id) {
              if (kind !== 'chat:message') return null;
              return (await messageAdapter.getById(id)) ?? null;
            },
            async updateComponents(kind, id, components) {
              if (kind !== 'chat:message') return;
              await messageAdapter.updateComponents({ id }, { components });
            },
          },
          evaluator: permissionsRef.evaluator,
        };
        getPluginState(app).set(CHAT_PLUGIN_STATE_KEY, chatState);
        app.route(`${mountPath}/encryption`, buildEncryptionRouter(chatState));
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });
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

/**
 * Chat package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts the 10 chat entities
 * (Room, RoomMember, Message, ReadReceipt, MessageReaction, Pin, Block,
 * FavoriteRoom, RoomInvite, Reminder), wires adapter-dependent middleware
 * (archiveGuard, broadcastGuard, dmRoomGuard, roomCreatorGrant, memberGrant,
 * messagePostCreate, messageNotify, memberInviteNotify, replyCountUpdate,
 * replyCountDecrement), publishes the `ChatInteractionsPeerCap` capability,
 * registers push formatters, opportunistically integrates with
 * `slingshot-embeds`, and starts the two 30-second schedulers (reminders +
 * scheduled messages) plus the WebSocket incoming-event dispatch.
 *
 * Every adapter ref, middleware closure, scheduler timer, and lazy
 * notification-builder reference is owned by the factory's closure (Rule 3)
 * — multiple package instances in the same process do not share state.
 */
import type { MiddlewareHandler } from 'hono';
import type {
  PermissionsState,
  PluginSetupContext,
  SlingshotPackageDefinition,
  WsPluginEndpoint,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  defineEvent,
  getContext,
  getPermissionsStateOrNull,
  getPluginState,
  getPluginStateOrNull,
  parseBody,
  provideCapability,
  publishPluginState,
  resolveCapabilityValue,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { NotificationsBuilderFactory } from '@lastshotlabs/slingshot-notifications';
import { chatPluginConfigSchema } from './config.schema';
import { buildChatEntityModules } from './entities/modules';
import {
  type ChatAdapterRefs,
  buildChatPluginStateSnapshot,
} from './entities/runtime';
import { resolveChatEncryptionProvider } from './encryption/provider';
import { buildEncryptionRouter } from './encryption/stub';
import type { ChatEncryptionProvider } from './encryption/types';
import { registerChatPushFormatters } from './lib/pushFormatters';
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
import { ChatInteractionsPeerCap } from './public';
import type { ChatInteractionsPeer } from './public';
import { CHAT_PLUGIN_STATE_KEY, CHAT_RUNTIME_KEY } from './state';
import type { Message as ChatMessage, ChatPluginConfig, ChatPluginState } from './types';
import { buildIncomingDispatch } from './ws/incoming';

/**
 * Create the chat package using the `definePackage` authoring path.
 *
 * Mounts all 10 chat entities — each entity module uses
 * `wiring: { mode: 'manual', buildAdapter }` so the package factory can
 * capture the resolved adapter into a closure-owned {@link ChatAdapterRefs}
 * bag for adapter-dependent middleware, custom-op handlers, and event
 * subscribers.
 *
 * **Cross-package contracts:**
 * - Requires `slingshot-permissions` for `PermissionsState`.
 * - Requires `slingshot-notifications` for `NotificationsBuilderFactory`.
 * - Publishes `ChatInteractionsPeerCap` for consumers (notably
 *   `slingshot-interactions`).
 *
 * **WebSocket self-wiring:** the package self-registers its incoming event
 * handlers onto `SlingshotContext.wsEndpoints[mountPath]` during
 * `setupPost`. No caller-side wiring is required.
 *
 * **Background schedulers:** during `setupPost` the package starts two
 * 30-second intervals — one for due reminders, one for scheduled message
 * delivery. Both are cleared in `teardown()`.
 *
 * **Optional integrations (duck-typed):**
 * - `slingshot-push` — when present, registers chat push formatters.
 * - `slingshot-embeds` — when present, unfurls URLs in new messages and
 *   writes the resolved embeds back via `attachEmbeds`.
 *
 * **Encryption:** when `config.encryption.provider === 'aes-gcm'`, encrypted
 * rooms (rooms with `encrypted: true`) store messages as ciphertext and
 * decrypt them on read. The room id is bound into the cipher as
 * authenticated data so ciphertext cannot be replayed across rooms.
 *
 * @param rawConfig - Package configuration. Validated at construction time.
 * @returns A `SlingshotPackageDefinition` suitable for
 *   `createApp({ packages: [...] })`.
 *
 * @throws {Error} If `rawConfig` fails Zod schema validation.
 * @throws {Error} If `PermissionsState` is absent when `setupMiddleware` runs.
 * @throws {Error} If `NotificationsBuilderFactory` is unavailable when
 *   `setupPost` runs.
 */
export function createChatPackage(rawConfig: ChatPluginConfig): SlingshotPackageDefinition {
  const config: Readonly<ChatPluginConfig> = deepFreeze(
    validatePluginConfig(CHAT_PLUGIN_STATE_KEY, rawConfig, chatPluginConfigSchema),
  );
  const tenantId = config.tenantId ?? 'default';
  const mountPath = config.mountPath ?? '/chat';
  const enablePresence = config.enablePresence ?? true;
  const encryptionProvider: ChatEncryptionProvider | null = resolveChatEncryptionProvider(
    config.encryption,
  );

  // ─── Closure-owned adapter refs (Rule 3 — no globals) ─────────────────────
  const refs: ChatAdapterRefs = {};

  // ─── Lazy middleware refs — all start as no-ops ───────────────────────────
  // Adapter-dependent refs (archiveGuard, broadcastGuard, dmRoomGuard,
  // roomCreatorGrant, messagePostCreate, replyCountUpdate,
  // replyCountDecrement) are populated inside `setupPost` once entity
  // adapters have been captured.
  // Permission-dependent refs (memberGrant) are populated in
  // `setupMiddleware` once permissions are resolved.
  // Notification-dependent refs (messageNotify, memberInviteNotify) are
  // populated in `setupPost` once `NotificationsBuilderFactory` is
  // resolvable through the capability system.
  type LazyMiddleware = { handler: MiddlewareHandler };
  const noop: MiddlewareHandler = async (_c, next) => next();
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
  const pollRequiredGuardRef: LazyMiddleware = { handler: noop };
  const attachmentRequiredGuardRef: LazyMiddleware = { handler: noop };

  // Permissions resolved in `setupMiddleware`; consumed in `setupPost` to
  // wire the contained adapter-dependent middleware.
  let permissionsRef: PermissionsState | undefined;
  let notificationsBuilderFactoryRef:
    | ((opts: { source: string }) => import('@lastshotlabs/slingshot-core').NotificationBuilder)
    | undefined;

  // Scheduler timers — cleared in teardown.
  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  let scheduledTimer: ReturnType<typeof setInterval> | undefined;

  // ─── Permissions adapter delegating proxy ─────────────────────────────────
  // The `findOrCreateDm` and `redeemInvite` custom-op handlers need a
  // permissions adapter at module-build time (entity modules are built
  // before `setupMiddleware` runs). We expose a delegating wrapper whose
  // target is filled in inside `setupMiddleware`.
  const permissionsAdapterRef: { current?: PermissionsState['adapter'] } = {};
  const permissionsAdapterProxy = {
    createGrant: (input: Record<string, unknown>) => {
      if (!permissionsAdapterRef.current) {
        throw new Error(
          '[slingshot-chat] Permissions adapter accessed before setupMiddleware resolved it',
        );
      }
      return permissionsAdapterRef.current.createGrant(input as never);
    },
  };

  // ─── Interactions peer (closure-bound to refs) ────────────────────────────
  // Built once at construction so the lifecycle phases and the capability
  // publish all share one instance. Closes over `refs.messages` so it
  // always sees the latest adapter reference.
  const interactionsPeer: ChatInteractionsPeer = {
    peerKind: 'chat',
    async resolveMessageByKindAndId(kind, id) {
      if (kind !== 'chat:message') return null;
      return (await refs.messages?.getById(id)) ?? null;
    },
    async updateComponents(kind, id, components) {
      if (kind !== 'chat:message' || !refs.messages) return;
      await refs.messages.updateComponents({ id }, { components });
    },
  };

  // ─── Build entity modules eagerly ─────────────────────────────────────────
  const entityModules = buildChatEntityModules({
    refs,
    permissionsAdapter: permissionsAdapterProxy,
    tenantId,
    encryptionProvider,
    enablePresence,
  });

  const entities = [
    entityModules.roomModule,
    entityModules.roomMemberModule,
    entityModules.messageModule,
    entityModules.readReceiptModule,
    entityModules.messageReactionModule,
    entityModules.pinModule,
    entityModules.blockModule,
    entityModules.favoriteRoomModule,
    entityModules.roomInviteModule,
    entityModules.reminderModule,
  ];

  // ─── Named middleware bundle ──────────────────────────────────────────────
  // The framework copies this map into the entity-plugin at boot. Each
  // entry closes over a stable ref the framework re-reads at request time.
  const middleware: Record<string, MiddlewareHandler> = {
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
    pollRequiredGuard: async (c, next) => pollRequiredGuardRef.handler(c, next),
    attachmentRequiredGuard: async (c, next) => attachmentRequiredGuardRef.handler(c, next),
  };

  return {
    kind: 'package' as const,
    name: CHAT_PLUGIN_STATE_KEY,
    mountPath,
    dependencies: ['slingshot-auth', 'slingshot-notifications', 'slingshot-permissions'],
    entities,
    domains: [] as const,
    middleware,
    capabilities: {
      provides: [provideCapability(ChatInteractionsPeerCap, () => interactionsPeer)],
      requires: [] as const,
    },

    async setupMiddleware({ app, events }: PluginSetupContext) {
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

      const permissions =
        getPermissionsStateOrNull(app) ??
        (() => {
          throw new Error(
            '[slingshot-chat] requires slingshot-permissions to be loaded before slingshot-chat',
          );
        })();
      permissionsRef = permissions;
      permissionsAdapterRef.current = permissions.adapter;

      // Publish the partial state slot now so legacy
      // `getPublishedInteractionsPeerOrNull` consumers can resolve the peer
      // through plugin state even before adapters are captured.
      publishPluginState(getPluginState(app), CHAT_PLUGIN_STATE_KEY, {
        interactionsPeer,
      } satisfies Pick<ChatPluginState, 'interactionsPeer'>);

      // Permission-dependent middleware (now that permissions are resolved).
      memberGrantRef.handler = createMemberGrantMiddleware({
        permissionsAdapter: permissions.adapter,
        tenantId,
      });

      // App-dependent peer guards.
      pollRequiredGuardRef.handler = buildPollRequiredGuard(app);
      attachmentRequiredGuardRef.handler = buildAttachmentRequiredGuard(app);
    },

    async setupRoutes({ app }: PluginSetupContext) {
      // The framework's `compilePackages` path runs the entity-plugin's
      // `setupRoutes` (which invokes each module's `wiring.buildAdapter`,
      // populating `refs`) before this hook fires. So adapters are
      // captured here.
      if (!permissionsRef) {
        throw new Error(
          '[slingshot-chat] permissions ref missing in setupRoutes — setupMiddleware did not run',
        );
      }
      const chatState = buildChatPluginStateSnapshot({
        refs,
        config,
        permissions: permissionsRef,
        interactionsPeer,
      });
      publishPluginState(getPluginState(app), CHAT_RUNTIME_KEY, chatState);
      app.route(`${mountPath}/encryption`, buildEncryptionRouter(chatState));
    },

    async setupPost({ app, bus, events }: PluginSetupContext) {
      // Resolve the notifications builder factory now that
      // `slingshot-notifications` has had its own `setupPost` run and
      // published the capability.
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

      if (!permissionsRef) {
        throw new Error(
          '[slingshot-chat] permissions ref missing in setupPost — setupMiddleware did not run',
        );
      }
      const permissions = permissionsRef;

      // ─── Adapter capture assertion ──────────────────────────────────────
      // Every adapter-dependent middleware below assumes refs are populated.
      // If any required adapter is missing at setupPost time, the entity
      // routes never mounted — surface that rather than silently no-op.
      if (
        !refs.rooms ||
        !refs.members ||
        !refs.messages ||
        !refs.receipts ||
        !refs.reactions ||
        !refs.pins ||
        !refs.blocks ||
        !refs.favorites
      ) {
        throw new Error(
          '[slingshot-chat] required adapters were not captured during entity setup',
        );
      }

      // ─── Adapter-dependent middleware ───────────────────────────────────
      archiveGuardRef.handler = createArchiveGuardMiddleware({
        roomAdapter: refs.rooms,
      });
      broadcastGuardRef.handler = createBroadcastGuardMiddleware({
        roomAdapter: refs.rooms,
        evaluator: permissions.evaluator,
        tenantId,
      });
      dmRoomGuardRef.handler = createDmRoomGuardMiddleware({
        roomAdapter: refs.rooms,
      });
      roomCreatorGrantRef.handler = createRoomCreatorGrantMiddleware({
        memberAdapter: refs.members,
        permissionsAdapter: permissions.adapter,
        tenantId,
      });
      messagePostCreateRef.handler = createMessagePostCreateMiddleware({
        roomAdapter: refs.rooms,
        permissionsAdapter: permissions.adapter,
        tenantId,
      });
      replyCountUpdateRef.handler = createReplyCountUpdateMiddleware({
        messageAdapter: refs.messages,
      });
      replyCountDecrementRef.handler = createReplyCountDecrementMiddleware({
        messageAdapter: refs.messages,
      });

      // ─── Notification-dependent middleware ──────────────────────────────
      const notificationBuilder = notificationsBuilderFactoryRef({ source: 'chat' });
      messageNotifyRef.handler = createMessageNotifyMiddleware({
        builder: notificationBuilder,
        roomAdapter: refs.rooms,
        memberAdapter: refs.members,
        messageAdapter: refs.messages,
      });
      memberInviteNotifyRef.handler = createMemberInviteNotifyMiddleware({
        builder: notificationBuilder,
        roomAdapter: refs.rooms,
      });

      // ─── Push formatter registration (optional peer integration) ────────
      const pushState = probePushFormatterRegistry(app);
      if (pushState) {
        registerChatPushFormatters(pushState);
      }

      // ─── parseBody → attachMentions bus subscriber ──────────────────────
      // Server-truth normalization of body mention tokens into the
      // message's mention sidecars. Closes the spoofing gap where a client
      // could set those arrays to arbitrary user IDs. Failures silent.
      const msgAdapter = refs.messages;
      bus.on('chat:message.created', async (payload: Record<string, unknown>) => {
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

      // ─── Embeds peer integration (optional) ─────────────────────────────
      const embedsState = probeEmbedsPeer(app);
      if (embedsState) {
        bus.on('chat:message.created', async (payload: Record<string, unknown>) => {
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

      // ─── Reminder scheduler ─────────────────────────────────────────────
      if (refs.reminders) {
        const remAdapter = refs.reminders;
        let reminderProcessing = false;
        reminderTimer = setInterval(async () => {
          if (reminderProcessing) return;
          reminderProcessing = true;
          try {
            const claimed = await remAdapter.claimDueReminders({ limit: 100 });
            for (const reminder of claimed) {
              bus.emit('chat:reminder.triggered', {
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

      // ─── Scheduled-message scheduler ────────────────────────────────────
      const messageAdapter = refs.messages;
      const roomAdapter = refs.rooms;
      let scheduledProcessing = false;
      scheduledTimer = setInterval(async () => {
        if (scheduledProcessing) return;
        scheduledProcessing = true;
        try {
          const claimed = await messageAdapter.claimDueScheduledMessages({ limit: 100 });
          for (const msg of claimed) {
            events.publish('chat:message.scheduled.delivered', msg, {
              source: 'system',
              userId: msg.authorId ?? null,
              // System-source scheduler — no originating HTTP request.
              requestTenantId: null,
            });
            await roomAdapter
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

      // ─── WebSocket incoming dispatch ────────────────────────────────────
      const pluginState = getPluginStateOrNull(app);
      if (pluginState) {
        // Re-publish the runtime state slot now that adapter-dependent
        // middleware is wired (some legacy consumers re-read after
        // setupPost completes).
        const chatState = buildChatPluginStateSnapshot({
          refs,
          config,
          permissions,
          interactionsPeer,
        });
        publishPluginState(pluginState, CHAT_RUNTIME_KEY, chatState);

        const incomingHandlers = buildIncomingDispatch(chatState, bus);
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
      }
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
  } satisfies SlingshotPackageDefinition;
}

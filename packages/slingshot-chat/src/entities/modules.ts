/**
 * Package-authoring entity modules for the chat package.
 *
 * Each entity uses `wiring: { mode: 'manual', buildAdapter }` so the package
 * factory can:
 *
 *   - Resolve the config-driven adapter via the framework's standard factory
 *     pipeline (the same path the standard wiring mode uses internally),
 *   - Apply per-entity adapter transforms (Message → `editedAt` then `cipher`),
 *   - Publish the resulting adapter into the shared {@link ChatAdapterRefs}
 *     bag so adapter-dependent middleware, custom-op handlers, and the
 *     plugin-state slot all see the same instance.
 *
 * Custom-op handlers (`findOrCreateDm`, `unreadCount`, `forwardMessage`,
 * `claimDueScheduledMessages`, `redeemInvite`, `claimInviteSlot`,
 * `releaseInviteSlot`, `claimDueReminders`) are mounted as `overrides` on
 * the corresponding modules — the route/auth/permission/middleware come
 * straight from the entity's `routes.operations.{name}` config so the HTTP
 * contract is unchanged.
 *
 * @internal
 */
import type { EntityChannelConfig, StoreInfra, StoreType } from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityRouteExecutionContext,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorOverrides,
} from '@lastshotlabs/slingshot-entity';
import type { ChatEncryptionProvider } from '../encryption/types';
import type { MessageAdapter, ReminderAdapter, RoomInviteAdapter } from '../types';
import { Block, blockOperations } from './block';
import { FavoriteRoom, favoriteRoomOperations } from './favoriteRoom';
import { Message, messageOperations } from './message';
import { MessageReaction, messageReactionOperations } from './messageReaction';
import { Pin, pinOperations } from './pin';
import { ReadReceipt, readReceiptOperations } from './readReceipt';
import { Reminder, reminderOperations } from './reminder';
import { Room, roomOperations } from './room';
import { RoomInvite, roomInviteOperations } from './roomInvite';
import { RoomMember, roomMemberOperations } from './roomMember';
import { RoomBan } from './roomBan';
import {
  type ChatAdapterRefs,
  type ChatPermissionsAdapter,
  applyCipherTransform,
  applyClaimDueRemindersMethod,
  applyClaimDueScheduledMessagesMethod,
  applyEditedAtTransform,
  applyMessageTombstoneTransform,
  applyInviteSlotMethods,
  asAdapter,
  createClaimDueRemindersHandler,
  createClaimDueScheduledMessagesHandler,
  createClaimInviteSlotHandler,
  createFindOrCreateDmHandler,
  createForwardMessageHandler,
  createRedeemInviteHandler,
  createReleaseInviteSlotHandler,
  createUnreadCountOpHandler,
} from './runtime';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter via the framework's standard-wiring code
 * path so manual-wiring entities here behave the same as the default
 * factory pipeline.
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

function buildRoomChannels(presence: boolean): EntityChannelConfig {
  return {
    channels: {
      live: {
        auth: 'userAuth' as const,
        permission: {
          requires: 'chat:room.read',
        },
        presence,
        forward: {
          events: [
            'chat:message.created',
            'chat:message.updated',
            'chat:message.deleted',
            'chat:message.reaction.added',
            'chat:message.reaction.removed',
            'chat:read.created',
          ],
          idField: 'roomId',
        },
        receive: {
          events: ['chat.typing'],
          toRoom: true,
          excludeSender: true,
        },
      },
    },
  };
}

export interface BuildChatEntityModulesArgs {
  /** Shared adapter refs populated as each entity is wired. */
  refs: ChatAdapterRefs;
  /** Permissions adapter used by `findOrCreateDm` + `redeemInvite`. */
  permissionsAdapter: ChatPermissionsAdapter;
  /** Tenant id propagated to grants issued during DM / invite redemption. */
  tenantId: string | null;
  /** Optional message-body encryption provider applied to encrypted rooms. */
  encryptionProvider: ChatEncryptionProvider | null;
  /** Whether the Room live channel should track presence. */
  enablePresence: boolean;
}

/**
 * Build all chat entity modules. Returns the 10-entity tuple ready for
 * `definePackage({ entities: [...] })`.
 */
export function buildChatEntityModules(args: BuildChatEntityModulesArgs) {
  const { refs, permissionsAdapter, tenantId, encryptionProvider, enablePresence } = args;

  // ─── Custom-op handler wrappers as override executors ──────────────────────
  const findOrCreateDm = createFindOrCreateDmHandler({ refs, permissionsAdapter, tenantId });
  const unreadCount = createUnreadCountOpHandler(refs);
  const claimDueScheduledMessages = createClaimDueScheduledMessagesHandler(refs);
  const forwardMessage = createForwardMessageHandler(refs);
  const redeemInvite = createRedeemInviteHandler({ refs, permissionsAdapter, tenantId });
  const claimInviteSlot = createClaimInviteSlotHandler(refs);
  const releaseInviteSlot = createReleaseInviteSlotHandler(refs);
  const claimDueReminders = createClaimDueRemindersHandler(refs);

  /**
   * Bind a custom-op handler to an entity route executor. Routing, auth, and
   * middleware are sourced from each entity's `routes.operations.{name}`
   * config.
   */
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

  // ─── Room ──────────────────────────────────────────────────────────────────
  const roomOverrides: EntityRouteExecutorOverrides = {
    operations: {
      findOrCreateDm: wrapHandler(findOrCreateDm),
    },
  };

  const roomModule = entity({
    config: Room,
    operations: roomOperations,
    channels: buildRoomChannels(enablePresence),
    overrides: roomOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Room,
          operations: roomOperations.operations,
          storeType,
          infra,
        });
        refs.rooms = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── RoomMember ────────────────────────────────────────────────────────────
  const roomMemberOverrides: EntityRouteExecutorOverrides = {
    operations: {
      unreadCount: wrapHandler(unreadCount),
    },
  };

  const roomMemberModule = entity({
    config: RoomMember,
    operations: roomMemberOperations,
    overrides: roomMemberOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: RoomMember,
          operations: roomMemberOperations.operations,
          storeType,
          infra,
        });
        refs.members = asAdapter(adapter);
        return adapter;
      },
    },
  });

  const roomBanModule = entity({
    config: RoomBan,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({ config: RoomBan, storeType, infra });
        const typed = asAdapter<import('../types').RoomBanAdapter>(adapter);
        typed.findByRoomUser = async (roomId, userId) => {
          const result = await typed.list({ filter: { roomId, userId }, limit: 1 });
          return result.items[0] ?? null;
        };
        refs.bans = typed;
        return adapter;
      },
    },
  });

  // ─── Message ───────────────────────────────────────────────────────────────
  // Adapter transforms compose innermost → outermost: editedAt first, then
  // cipher.
  const messageOverrides: EntityRouteExecutorOverrides = {
    operations: {
      forwardMessage: wrapHandler(forwardMessage),
      claimDueScheduledMessages: wrapHandler(claimDueScheduledMessages),
    },
  };

  const messageModule = entity({
    config: Message,
    operations: messageOperations,
    overrides: messageOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({
          config: Message,
          operations: messageOperations.operations,
          storeType,
          infra,
        });
        const withEdited = applyEditedAtTransform(asAdapter<MessageAdapter>(base));
        const withCipher = applyCipherTransform(
          asAdapter<MessageAdapter>(withEdited),
          encryptionProvider,
          refs,
        );
        // Attach the `claimDueScheduledMessages` method so the
        // scheduled-delivery interval and tests can call it directly.
        const tombstoned = applyMessageTombstoneTransform(asAdapter<MessageAdapter>(withCipher));
        const wrapped = applyClaimDueScheduledMessagesMethod(asAdapter<MessageAdapter>(tombstoned));
        refs.messages = asAdapter(wrapped);
        return wrapped;
      },
    },
  });

  // ─── ReadReceipt ───────────────────────────────────────────────────────────
  const readReceiptModule = entity({
    config: ReadReceipt,
    operations: readReceiptOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: ReadReceipt,
          operations: readReceiptOperations.operations,
          storeType,
          infra,
        });
        refs.receipts = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── MessageReaction ───────────────────────────────────────────────────────
  const messageReactionModule = entity({
    config: MessageReaction,
    operations: messageReactionOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: MessageReaction,
          operations: messageReactionOperations.operations,
          storeType,
          infra,
        });
        refs.reactions = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Pin ───────────────────────────────────────────────────────────────────
  const pinModule = entity({
    config: Pin,
    operations: pinOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Pin,
          operations: pinOperations.operations,
          storeType,
          infra,
        });
        refs.pins = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Block ─────────────────────────────────────────────────────────────────
  const blockModule = entity({
    config: Block,
    operations: blockOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Block,
          operations: blockOperations.operations,
          storeType,
          infra,
        });
        refs.blocks = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── FavoriteRoom ──────────────────────────────────────────────────────────
  const favoriteRoomModule = entity({
    config: FavoriteRoom,
    operations: favoriteRoomOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: FavoriteRoom,
          operations: favoriteRoomOperations.operations,
          storeType,
          infra,
        });
        refs.favorites = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── RoomInvite ────────────────────────────────────────────────────────────
  const roomInviteOverrides: EntityRouteExecutorOverrides = {
    operations: {
      redeemInvite: wrapHandler(redeemInvite),
      claimInviteSlot: wrapHandler(claimInviteSlot),
      releaseInviteSlot: wrapHandler(releaseInviteSlot),
    },
  };

  const roomInviteModule = entity({
    config: RoomInvite,
    operations: roomInviteOperations,
    overrides: roomInviteOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({
          config: RoomInvite,
          operations: roomInviteOperations.operations,
          storeType,
          infra,
        });
        const wrapped = applyInviteSlotMethods(asAdapter<RoomInviteAdapter>(base));
        refs.invites = asAdapter(wrapped);
        return wrapped;
      },
    },
  });

  // ─── Reminder ──────────────────────────────────────────────────────────────
  const reminderOverrides: EntityRouteExecutorOverrides = {
    operations: {
      claimDueReminders: wrapHandler(claimDueReminders),
    },
  };

  const reminderModule = entity({
    config: Reminder,
    operations: reminderOperations,
    overrides: reminderOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = resolveStandardAdapter({
          config: Reminder,
          operations: reminderOperations.operations,
          storeType,
          infra,
        });
        const wrapped = applyClaimDueRemindersMethod(asAdapter<ReminderAdapter>(base));
        refs.reminders = asAdapter(wrapped);
        return wrapped;
      },
    },
  });

  return {
    roomModule,
    roomMemberModule,
    roomBanModule,
    messageModule,
    readReceiptModule,
    messageReactionModule,
    pinModule,
    blockModule,
    favoriteRoomModule,
    roomInviteModule,
    reminderModule,
  };
}

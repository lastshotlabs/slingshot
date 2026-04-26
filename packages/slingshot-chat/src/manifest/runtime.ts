import { HTTPException } from 'hono/http-exception';
import type { PermissionsState } from '@lastshotlabs/slingshot-core';
import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityAdapterTransformRegistry,
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import type { ChatEncryptionProvider } from '../encryption/types';
import { getUserId } from '../lib/ctx';
import { createUnreadCountHandler } from '../lib/unreadCount';
import { now } from '../lib/utils';
import type { ChatPluginState, CreateMessageInput, Message, UpdateMessageInput } from '../types';

type AdapterRefs = Pick<
  ChatPluginState,
  | 'rooms'
  | 'members'
  | 'messages'
  | 'receipts'
  | 'reactions'
  | 'pins'
  | 'blocks'
  | 'favorites'
  | 'invites'
  | 'reminders'
>;

function withEditedAt(input: UpdateMessageInput): UpdateMessageInput {
  if (typeof input.body !== 'string') {
    return input;
  }

  return {
    ...input,
    editedAt: now(),
  };
}

function hasMethod(value: BareEntityAdapter, method: string): boolean {
  return typeof value[method] === 'function';
}

function isRoomAdapter(value: unknown): value is ChatPluginState['rooms'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'findDm') &&
    hasMethod(adapter, 'updateLastMessage') &&
    hasMethod(adapter, 'archiveRoom') &&
    hasMethod(adapter, 'unarchiveRoom')
  );
}

function isRoomMemberAdapter(value: unknown): value is ChatPluginState['members'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'listByRoom') &&
    hasMethod(adapter, 'listByUser') &&
    hasMethod(adapter, 'findMember') &&
    hasMethod(adapter, 'updateLastRead') &&
    hasMethod(adapter, 'countMembers')
  );
}

function isMessageAdapter(value: unknown): value is ChatPluginState['messages'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'listByRoom') &&
    hasMethod(adapter, 'updateComponents') &&
    hasMethod(adapter, 'listReplies') &&
    hasMethod(adapter, 'incrementReplyCount') &&
    hasMethod(adapter, 'decrementReplyCount') &&
    hasMethod(adapter, 'attachEmbeds')
  );
}

function isReadReceiptAdapter(value: unknown): value is ChatPluginState['receipts'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'upsertReceipt') && hasMethod(adapter, 'latestForUserInRoom');
}

function isMessageReactionAdapter(value: unknown): value is ChatPluginState['reactions'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'addReaction') && hasMethod(adapter, 'removeReaction');
}

function isPinAdapter(value: unknown): value is ChatPluginState['pins'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'listByRoom') && hasMethod(adapter, 'unpin');
}

function isBlockAdapter(value: unknown): value is ChatPluginState['blocks'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'isBlocked') && hasMethod(adapter, 'unblockUser');
}

function isFavoriteRoomAdapter(value: unknown): value is ChatPluginState['favorites'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'listByUser') && hasMethod(adapter, 'isFavorite');
}

function isRoomInviteAdapter(value: unknown): value is NonNullable<ChatPluginState['invites']> {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'findByToken') && hasMethod(adapter, 'revokeInvite');
}

function isReminderAdapter(value: unknown): value is NonNullable<ChatPluginState['reminders']> {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'listPending');
}

function requireRoomAdapter(value: BareEntityAdapter): ChatPluginState['rooms'] {
  if (!isRoomAdapter(value)) {
    throw new Error('[slingshot-chat] Room adapter is missing required room operations');
  }
  return value;
}

function requireRoomMemberAdapter(value: BareEntityAdapter): ChatPluginState['members'] {
  if (!isRoomMemberAdapter(value)) {
    throw new Error('[slingshot-chat] RoomMember adapter is missing required member operations');
  }
  return value;
}

function requireMessageAdapter(value: BareEntityAdapter): ChatPluginState['messages'] {
  if (!isMessageAdapter(value)) {
    throw new Error('[slingshot-chat] Message adapter is missing required message operations');
  }
  return value;
}

function requireReadReceiptAdapter(value: BareEntityAdapter): ChatPluginState['receipts'] {
  if (!isReadReceiptAdapter(value)) {
    throw new Error('[slingshot-chat] ReadReceipt adapter is missing required receipt operations');
  }
  return value;
}

function requireMessageReactionAdapter(value: BareEntityAdapter): ChatPluginState['reactions'] {
  if (!isMessageReactionAdapter(value)) {
    throw new Error(
      '[slingshot-chat] MessageReaction adapter is missing required reaction operations',
    );
  }
  return value;
}

function requirePinAdapter(value: BareEntityAdapter): ChatPluginState['pins'] {
  if (!isPinAdapter(value)) {
    throw new Error('[slingshot-chat] Pin adapter is missing required pin operations');
  }
  return value;
}

function requireBlockAdapter(value: BareEntityAdapter): ChatPluginState['blocks'] {
  if (!isBlockAdapter(value)) {
    throw new Error('[slingshot-chat] Block adapter is missing required block operations');
  }
  return value;
}

function requireFavoriteRoomAdapter(value: BareEntityAdapter): ChatPluginState['favorites'] {
  if (!isFavoriteRoomAdapter(value)) {
    throw new Error(
      '[slingshot-chat] FavoriteRoom adapter is missing required favorite operations',
    );
  }
  return value;
}

function requireRoomInviteAdapter(
  value: BareEntityAdapter,
): NonNullable<ChatPluginState['invites']> {
  if (!isRoomInviteAdapter(value)) {
    throw new Error('[slingshot-chat] RoomInvite adapter is missing required invite operations');
  }
  return value;
}

function requireReminderAdapter(
  value: BareEntityAdapter,
): NonNullable<ChatPluginState['reminders']> {
  if (!isReminderAdapter(value)) {
    throw new Error('[slingshot-chat] Reminder adapter is missing required reminder operations');
  }
  return value;
}

function requirePermissions(value: PermissionsState | undefined): PermissionsState {
  if (!value) {
    throw new Error('[slingshot-chat] Permissions state is not ready during manifest bootstrap');
  }
  return value;
}

function requireMessageCipher(
  provider: ChatEncryptionProvider | null,
): ChatEncryptionProvider | null {
  return provider;
}

/**
 * Build the manifest runtime for `chatManifest`.
 *
 * Runtime handlers keep DM orchestration, unread counts, encryption, invite
 * redemption, and scheduler claim operations package-owned while persistence
 * itself is manifest-driven.
 */
export function createChatManifestRuntime(args: {
  tenantId: string;
  permissions: PermissionsState | undefined;
  encryptionProvider: ChatEncryptionProvider | null;
  setAdapters: (adapters: AdapterRefs) => void;
}): EntityManifestRuntime {
  const { tenantId, permissions, encryptionProvider, setAdapters } = args;
  const customHandlers = createEntityHandlerRegistry();
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const hooks = createEntityPluginHookRegistry();

  let roomAdapterRef: ChatPluginState['rooms'] | undefined;
  let memberAdapterRef: ChatPluginState['members'] | undefined;
  let messageAdapterRef: ChatPluginState['messages'] | undefined;
  let blockAdapterRef: ChatPluginState['blocks'] | undefined;
  let inviteAdapterRef: NonNullable<ChatPluginState['invites']> | undefined;
  let reminderAdapterRef: NonNullable<ChatPluginState['reminders']> | undefined;

  adapterTransforms.register('chat.message.editedAt', (adapter: BareEntityAdapter) => {
    const messageAdapter = requireMessageAdapter(adapter);
    return {
      ...adapter,
      update: async (id: string, input: unknown) => {
        const typedInput = input as UpdateMessageInput;
        return messageAdapter.update(id, withEditedAt(typedInput));
      },
    };
  });

  adapterTransforms.register('chat.message.cipher', (adapter: BareEntityAdapter) => {
    const provider = requireMessageCipher(encryptionProvider);
    if (!provider) {
      return adapter;
    }
    const messageAdapter = requireMessageAdapter(adapter);
    const getRoom = (roomId: string) => roomAdapterRef?.getById(roomId) ?? Promise.resolve(null);

    return {
      ...adapter,
      create: async (input: unknown) => {
        const typedInput = input as CreateMessageInput;
        const room = await getRoom(typedInput.roomId);
        if (room?.encrypted) {
          const result = await messageAdapter.create({
            ...typedInput,
            body: await provider.encrypt(typedInput.body, typedInput.roomId),
          });
          return { ...result, body: typedInput.body };
        }
        return messageAdapter.create(typedInput);
      },
      update: async (id: string, input: unknown) => {
        const typedInput = input as UpdateMessageInput;
        if (typeof typedInput.body === 'string') {
          const existing = await messageAdapter.getById(id);
          if (existing) {
            const room = await getRoom(existing.roomId);
            if (room?.encrypted) {
              const encryptedInput: UpdateMessageInput = {
                ...typedInput,
                body: await provider.encrypt(typedInput.body, existing.roomId),
              };
              const result = await messageAdapter.update(id, encryptedInput);
              return result ? { ...result, body: typedInput.body } : result;
            }
          }
        }
        return messageAdapter.update(id, typedInput);
      },
      getById: async (id: string) => {
        const message = await messageAdapter.getById(id);
        if (!message) return null;
        const room = await getRoom(message.roomId);
        if (!room?.encrypted) {
          return message;
        }
        return { ...message, body: await provider.decrypt(message.body, message.roomId) };
      },
      listByRoom: async (params: Record<string, unknown>) => {
        const typedParams = params as { roomId: string; cursor?: string; limit?: number };
        const page = await messageAdapter.listByRoom(typedParams);
        const items = await Promise.all(
          page.items.map(async (message: Message) => {
            const room = await getRoom(message.roomId);
            if (!room?.encrypted) {
              return message;
            }
            return {
              ...message,
              body: await provider.decrypt(message.body, message.roomId),
            };
          }),
        );
        return { ...page, items };
      },
    };
  });

  hooks.register('chat.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    roomAdapterRef = requireRoomAdapter(ctx.adapters.Room);
    memberAdapterRef = requireRoomMemberAdapter(ctx.adapters.RoomMember);
    messageAdapterRef = requireMessageAdapter(ctx.adapters.Message);
    blockAdapterRef = requireBlockAdapter(ctx.adapters.Block);
    inviteAdapterRef = requireRoomInviteAdapter(ctx.adapters.RoomInvite);
    reminderAdapterRef = requireReminderAdapter(ctx.adapters.Reminder);

    setAdapters({
      rooms: roomAdapterRef,
      members: memberAdapterRef,
      messages: messageAdapterRef,
      receipts: requireReadReceiptAdapter(ctx.adapters.ReadReceipt),
      reactions: requireMessageReactionAdapter(ctx.adapters.MessageReaction),
      pins: requirePinAdapter(ctx.adapters.Pin),
      blocks: blockAdapterRef,
      favorites: requireFavoriteRoomAdapter(ctx.adapters.FavoriteRoom),
      invites: inviteAdapterRef,
      reminders: reminderAdapterRef,
    });
  });

  customHandlers.register('chat.room.findOrCreateDm', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const targetUserId = typeof params.targetUserId === 'string' ? params.targetUserId : '';
    const roomAdapter = roomAdapterRef;
    const memberAdapter = memberAdapterRef;
    const blockAdapter = blockAdapterRef;
    const permissionsState = requirePermissions(permissions);

    if (!roomAdapter || !memberAdapter || !blockAdapter) {
      throw new Error('[slingshot-chat] DM handler executed before adapters were captured');
    }
    if (!targetUserId) {
      throw new HTTPException(400, { message: 'targetUserId is required' });
    }
    if (targetUserId === userId) {
      throw new HTTPException(400, { message: 'Cannot DM yourself' });
    }

    const [initiatorBlocked, targetBlocked] = await Promise.all([
      blockAdapter.isBlocked({ blockerId: userId, blockedId: targetUserId }),
      blockAdapter.isBlocked({ blockerId: targetUserId, blockedId: userId }),
    ]);
    if (initiatorBlocked || targetBlocked) {
      throw new HTTPException(403, { message: 'Forbidden - blocked' });
    }

    const dmId = `dm-${[userId, targetUserId].sort().join('-')}`;
    let room = await roomAdapter.getById(dmId);
    if (!room) {
      room = await roomAdapter.create({
        id: dmId,
        name: null,
        type: 'dm',
        encrypted: false,
        retentionDays: null,
      });

      await Promise.all([
        memberAdapter.create({ roomId: room.id, userId, role: 'member' }),
        memberAdapter.create({ roomId: room.id, userId: targetUserId, role: 'member' }),
      ]);

      await Promise.all([
        permissionsState.adapter.createGrant({
          subjectId: userId,
          subjectType: 'user',
          resourceType: 'chat:room',
          resourceId: room.id,
          tenantId,
          roles: ['member'],
          effect: 'allow',
          grantedBy: userId,
        }),
        permissionsState.adapter.createGrant({
          subjectId: targetUserId,
          subjectType: 'user',
          resourceType: 'chat:room',
          resourceId: room.id,
          tenantId,
          roles: ['member'],
          effect: 'allow',
          grantedBy: userId,
        }),
      ]);
    }

    return { room };
  });

  customHandlers.register('chat.member.unreadCount', () => () => async (input: unknown) => {
    const memberAdapter = memberAdapterRef;
    const messageAdapter = messageAdapterRef;
    if (!memberAdapter || !messageAdapter) {
      throw new Error('[slingshot-chat] unreadCount executed before adapters were captured');
    }
    return createUnreadCountHandler({
      memberAdapter,
      messageAdapter: {
        listByRoom: (params: { roomId: string; cursor?: string; limit?: number }) =>
          messageAdapter.listByRoom(params),
      },
    })((input ?? {}) as Record<string, unknown>);
  });

  customHandlers.register(
    'chat.message.claimDueScheduledMessages',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as { limit?: number };
      const messageAdapter = messageAdapterRef;
      if (!messageAdapter) {
        throw new Error(
          '[slingshot-chat] claimDueScheduledMessages executed before adapters were captured',
        );
      }
      const pending = await messageAdapter.list({
        filter: { scheduledDelivered: false },
        limit: params.limit,
      });
      const due = pending.items.filter(
        message => message.scheduledAt && new Date(message.scheduledAt).getTime() <= Date.now(),
      );
      const claimed: typeof due = [];
      for (const message of due) {
        const updated = await messageAdapter.update(message.id, { scheduledDelivered: true });
        if (updated) {
          claimed.push(updated);
        }
      }
      return claimed;
    },
  );

  customHandlers.register('chat.message.forward', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const messageId = typeof params.messageId === 'string' ? params.messageId : '';
    const targetRoomId = typeof params.targetRoomId === 'string' ? params.targetRoomId : '';
    const messageAdapter = messageAdapterRef;
    const memberAdapter = memberAdapterRef;
    const roomAdapter = roomAdapterRef;

    if (!messageAdapter || !memberAdapter || !roomAdapter) {
      throw new Error('[slingshot-chat] forwardMessage executed before adapters were captured');
    }
    if (!messageId || !targetRoomId) {
      throw new HTTPException(400, { message: 'messageId and targetRoomId are required' });
    }

    const sourceMessage = await messageAdapter.getById(messageId);
    if (!sourceMessage) {
      throw new HTTPException(404, { message: 'Source message not found' });
    }

    const targetMember = await memberAdapter.findMember({ roomId: targetRoomId, userId });
    if (!targetMember) {
      throw new HTTPException(403, { message: 'Not a member of target room' });
    }

    const targetRoom = await roomAdapter.getById(targetRoomId);
    if (targetRoom?.archived) {
      throw new HTTPException(403, { message: 'Target room is archived' });
    }

    const forwarded = await messageAdapter.create({
      roomId: targetRoomId,
      authorId: userId,
      body: sourceMessage.body,
      type: sourceMessage.type,
      forwardedFromId: sourceMessage.id,
      appMetadata: {
        forwarded: true,
        originalAuthorId: sourceMessage.authorId,
        originalCreatedAt: sourceMessage.createdAt,
      },
    });

    await roomAdapter.updateLastMessage(
      { id: targetRoomId },
      { lastMessageAt: forwarded.createdAt, lastMessageId: forwarded.id },
    );

    return { message: forwarded };
  });

  customHandlers.register('chat.invite.redeem', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const token = typeof params.token === 'string' ? params.token : '';
    const memberAdapter = memberAdapterRef;
    const roomAdapter = roomAdapterRef;
    const blockAdapter = blockAdapterRef;
    const inviteAdapter = inviteAdapterRef;
    const permissionsState = requirePermissions(permissions);

    if (!memberAdapter || !roomAdapter || !blockAdapter || !inviteAdapter) {
      throw new Error('[slingshot-chat] redeemInvite executed before adapters were captured');
    }
    if (!token) {
      throw new HTTPException(400, { message: 'token is required' });
    }

    const invite = await inviteAdapter.findByToken({ token });
    if (!invite) {
      throw new HTTPException(404, { message: 'Invite not found' });
    }
    if (invite.revoked) {
      throw new HTTPException(410, { message: 'Invite has been revoked' });
    }
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new HTTPException(410, { message: 'Invite has expired' });
    }

    const existing = await memberAdapter.findMember({ roomId: invite.roomId, userId });
    if (existing) {
      const room = await roomAdapter.getById(invite.roomId);
      return { room, member: existing, alreadyMember: true };
    }

    const blocked = await blockAdapter.isBlocked({
      blockerId: invite.createdBy,
      blockedId: userId,
    });
    if (blocked) {
      throw new HTTPException(403, { message: 'Forbidden' });
    }

    if (invite.maxUses != null && invite.useCount >= invite.maxUses) {
      throw new HTTPException(410, { message: 'Invite has reached its use limit' });
    }

    const claimed = await inviteAdapter.claimInviteSlot({ id: invite.id });
    if (!claimed) {
      throw new HTTPException(410, { message: 'Invite has reached its use limit' });
    }

    let member;
    try {
      member = await memberAdapter.create({ roomId: invite.roomId, userId, role: 'member' });
    } catch (error) {
      await inviteAdapter.releaseInviteSlot({ id: invite.id }).catch(() => {});
      throw error;
    }

    await permissionsState.adapter
      .createGrant({
        subjectId: userId,
        subjectType: 'user',
        resourceType: 'chat:room',
        resourceId: invite.roomId,
        tenantId,
        roles: ['member'],
        effect: 'allow',
        grantedBy: invite.createdBy,
      })
      .catch(() => {});

    const room = await roomAdapter.getById(invite.roomId);
    return { room, member, alreadyMember: false };
  });

  customHandlers.register('chat.invite.claimInviteSlot', () => () => async (input: unknown) => {
    const params = (input ?? {}) as { id?: string };
    const inviteAdapter = inviteAdapterRef;
    if (!inviteAdapter) {
      throw new Error('[slingshot-chat] claimInviteSlot executed before adapters were captured');
    }
    if (!params.id) {
      return null;
    }
    const invite = await inviteAdapter.getById(params.id);
    if (!invite) return null;
    if (invite.maxUses != null && invite.useCount >= invite.maxUses) return null;
    return inviteAdapter.update(invite.id, { useCount: invite.useCount + 1 });
  });

  customHandlers.register('chat.invite.releaseInviteSlot', () => () => async (input: unknown) => {
    const params = (input ?? {}) as { id?: string };
    const inviteAdapter = inviteAdapterRef;
    if (!inviteAdapter) {
      throw new Error('[slingshot-chat] releaseInviteSlot executed before adapters were captured');
    }
    if (!params.id) {
      return null;
    }
    const invite = await inviteAdapter.getById(params.id);
    if (!invite || invite.useCount <= 0) return null;
    return inviteAdapter.update(invite.id, { useCount: invite.useCount - 1 });
  });

  customHandlers.register('chat.reminder.claimDueReminders', () => () => async (input: unknown) => {
    const params = (input ?? {}) as { limit?: number };
    const reminderAdapter = reminderAdapterRef;
    if (!reminderAdapter) {
      throw new Error('[slingshot-chat] claimDueReminders executed before adapters were captured');
    }
    const pending = await reminderAdapter.list({
      filter: { triggered: false },
      limit: params.limit,
    });
    const due = pending.items.filter(
      reminder => new Date(reminder.triggerAt).getTime() <= Date.now(),
    );
    const claimed: typeof due = [];
    for (const reminder of due) {
      const updated = await reminderAdapter.update(reminder.id, { triggered: true });
      if (updated) {
        claimed.push(updated);
      }
    }
    return claimed;
  });

  return {
    customHandlers,
    adapterTransforms,
    hooks,
  };
}

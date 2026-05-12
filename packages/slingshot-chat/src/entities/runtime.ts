/**
 * Pure runtime helpers used by the chat entity modules and the package
 * factory.
 *
 * Houses:
 *   - The shared adapter ref bag populated by each entity module's
 *     `wiring.buildAdapter` callback during bootstrap.
 *   - Adapter transforms (`withEditedAt`, `withCipher`) wrapped around the
 *     resolved Message adapter inside the Message module.
 *   - Lifted custom-op handlers (`findOrCreateDm`, `unreadCount`,
 *     `claimDueScheduledMessages`, `forwardMessage`, `redeemInvite`,
 *     `claimInviteSlot`, `releaseInviteSlot`, `claimDueReminders`).
 *
 * Every export here is either a plain adapter ref shape, a plain async
 * handler, or a small typed builder. The middleware factories that consume
 * adapter refs are wired separately by the package factory.
 */
import { HTTPException } from 'hono/http-exception';
import type { PermissionsState } from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import type { ChatEncryptionProvider } from '../encryption/types';
import { getUserId } from '../lib/ctx';
import { createUnreadCountHandler } from '../lib/unreadCount';
import { now } from '../lib/utils';
import type {
  BlockAdapter,
  ChatPluginState,
  CreateMessageInput,
  FavoriteRoomAdapter,
  Message,
  MessageAdapter,
  MessageReactionAdapter,
  PinAdapter,
  ReadReceiptAdapter,
  ReminderAdapter,
  RoomAdapter,
  RoomInviteAdapter,
  RoomMemberAdapter,
  UpdateMessageInput,
} from '../types';

// ---------------------------------------------------------------------------
// Shared adapter refs bag
// ---------------------------------------------------------------------------

/**
 * Shared adapter ref bag populated by each entity module's
 * `wiring.buildAdapter` callback during bootstrap.
 *
 * Custom-op handlers and adapter-dependent middleware read through these
 * refs at request time so each package instance keeps its own adapters
 * (Rule 3 — closure-owned state, no globals).
 */
export interface ChatAdapterRefs {
  rooms?: RoomAdapter;
  members?: RoomMemberAdapter;
  messages?: MessageAdapter;
  receipts?: ReadReceiptAdapter;
  reactions?: MessageReactionAdapter;
  pins?: PinAdapter;
  blocks?: BlockAdapter;
  favorites?: FavoriteRoomAdapter;
  invites?: RoomInviteAdapter;
  reminders?: ReminderAdapter;
}

/** Narrow `BareEntityAdapter` to one of the chat adapter shapes. */
export function asAdapter<T>(adapter: BareEntityAdapter): T {
  return adapter as unknown as T;
}

// ---------------------------------------------------------------------------
// Message adapter transforms
// ---------------------------------------------------------------------------

function withEditedAtInput(input: UpdateMessageInput): UpdateMessageInput {
  if (typeof input.body !== 'string') {
    return input;
  }
  return { ...input, editedAt: now() };
}

/**
 * Wrap the resolved Message adapter to auto-stamp `editedAt` whenever the
 * caller updates the message body. Mirrors the legacy
 * `chat.message.editedAt` manifest transform.
 *
 * Callers pass the typed `MessageAdapter` view of the resolved adapter so
 * this wrapper can call typed methods directly. The return is widened to
 * `BareEntityAdapter` to satisfy the manual-wiring contract — the bare
 * shape's loosely-typed CRUD is structurally a supertype of `MessageAdapter`
 * but TS can't see the assignment, so a single boundary cast remains.
 */
export function applyEditedAtTransform(messageAdapter: MessageAdapter): BareEntityAdapter {
  return {
    ...messageAdapter,
    update: async (id: string, input: unknown) => {
      const typedInput = input as UpdateMessageInput;
      return messageAdapter.update(id, withEditedAtInput(typedInput));
    },
  } as unknown as BareEntityAdapter;
}

/**
 * Wrap the resolved Message adapter so encrypted-room messages are stored as
 * ciphertext and decrypted on read. When `provider` is null the adapter is
 * returned unchanged. Mirrors the legacy `chat.message.cipher` transform.
 *
 * Reads `roomAdapterRef.rooms` from the shared refs bag at request time so
 * the encryption layer always sees the latest Room adapter.
 */
export function applyCipherTransform(
  messageAdapter: MessageAdapter,
  provider: ChatEncryptionProvider | null,
  refs: ChatAdapterRefs,
): BareEntityAdapter {
  if (!provider) {
    return messageAdapter as unknown as BareEntityAdapter;
  }
  const getRoom = (roomId: string) =>
    refs.rooms?.getById(roomId) ?? Promise.resolve(null);

  return {
    ...messageAdapter,
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
  } as unknown as BareEntityAdapter;
}

// ---------------------------------------------------------------------------
// Permissions adapter slice
// ---------------------------------------------------------------------------

/**
 * Minimal permissions adapter slice consumed by the DM and invite redemption
 * handlers. Lets those flows issue per-user grants without leaking the full
 * {@link PermissionsState} surface.
 */
export interface ChatPermissionsAdapter {
  createGrant(input: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Custom-op handlers (lifted from the manifest runtime)
// ---------------------------------------------------------------------------

export interface CreateFindOrCreateDmHandlerArgs {
  refs: ChatAdapterRefs;
  permissionsAdapter: ChatPermissionsAdapter;
  tenantId: string;
}

/**
 * Build the `findOrCreateDm` handler — mirrors the legacy manifest
 * `chat.room.findOrCreateDm` exactly.
 *
 * Deterministic room id `dm-{sorted(userId,targetUserId).join('-')}`,
 * bidirectional block check (403), idempotent on second call.
 */
export function createFindOrCreateDmHandler(args: CreateFindOrCreateDmHandlerArgs) {
  const { refs, permissionsAdapter, tenantId } = args;
  return async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const targetUserId = typeof params.targetUserId === 'string' ? params.targetUserId : '';
    const roomAdapter = refs.rooms;
    const memberAdapter = refs.members;
    const blockAdapter = refs.blocks;

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
        permissionsAdapter.createGrant({
          subjectId: userId,
          subjectType: 'user',
          resourceType: 'chat:room',
          resourceId: room.id,
          tenantId,
          roles: ['member'],
          effect: 'allow',
          grantedBy: userId,
        }),
        permissionsAdapter.createGrant({
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
  };
}

/**
 * Build the `unreadCount` handler bound to a refs bag.
 *
 * Mirrors the legacy `chat.member.unreadCount` manifest handler. Reads
 * member adapter for memberships and message adapter for `listByRoom` to
 * count unread messages per room.
 */
export function createUnreadCountOpHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const memberAdapter = refs.members;
    const messageAdapter = refs.messages;
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
  };
}

/**
 * Build the `claimDueScheduledMessages` operation bound to a Message
 * adapter instance. Called both as an HTTP route handler (mounted as an
 * override on the Message module) and directly by the scheduled-delivery
 * interval through the attached adapter method.
 *
 * Internal — lists pending scheduled messages, filters to those with
 * `scheduledAt <= now`, and atomically flips `scheduledDelivered: true`.
 */
export function buildClaimDueScheduledMessagesOp(messageAdapter: MessageAdapter) {
  return async (params: { limit?: number } = {}) => {
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
  };
}

/** Build the refs-bound HTTP-form handler for `claimDueScheduledMessages`. */
export function createClaimDueScheduledMessagesHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const params = (input ?? {}) as { limit?: number };
    const messageAdapter = refs.messages;
    if (!messageAdapter) {
      throw new Error(
        '[slingshot-chat] claimDueScheduledMessages executed before adapters were captured',
      );
    }
    return buildClaimDueScheduledMessagesOp(messageAdapter)(params);
  };
}

/**
 * Wrap a Message adapter so the `claimDueScheduledMessages` op is callable
 * directly through the adapter (used by the scheduled-delivery interval
 * and by test fixtures that exercise the adapter without going through HTTP).
 */
export function applyClaimDueScheduledMessagesMethod(
  messageAdapter: MessageAdapter,
): BareEntityAdapter {
  const claim = buildClaimDueScheduledMessagesOp(messageAdapter);
  return {
    ...messageAdapter,
    claimDueScheduledMessages: (params: { limit: number }) => claim(params),
  } as unknown as BareEntityAdapter;
}

/**
 * Build the `forwardMessage` handler bound to a refs bag.
 *
 * Mirrors the legacy `chat.message.forward` manifest handler exactly.
 * Validates source/target membership, target room archive state, then
 * creates a forwarded message with `forwardedFromId` referencing the
 * original.
 */
export function createForwardMessageHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const messageId = typeof params.messageId === 'string' ? params.messageId : '';
    const targetRoomId = typeof params.targetRoomId === 'string' ? params.targetRoomId : '';
    const messageAdapter = refs.messages;
    const memberAdapter = refs.members;
    const roomAdapter = refs.rooms;

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
    if (
      sourceMessage.deletedAt ||
      (sourceMessage.scheduledAt && !sourceMessage.scheduledDelivered)
    ) {
      throw new HTTPException(404, { message: 'Source message not found' });
    }

    const sourceMember = await memberAdapter.findMember({ roomId: sourceMessage.roomId, userId });
    if (!sourceMember) {
      throw new HTTPException(403, { message: 'Not a member of source room' });
    }

    const targetMember = await memberAdapter.findMember({ roomId: targetRoomId, userId });
    if (!targetMember) {
      throw new HTTPException(403, { message: 'Not a member of target room' });
    }

    const targetRoom = await roomAdapter.getById(targetRoomId);
    if (!targetRoom) {
      throw new HTTPException(404, { message: 'Target room not found' });
    }
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
  };
}

export interface CreateRedeemInviteHandlerArgs {
  refs: ChatAdapterRefs;
  permissionsAdapter: ChatPermissionsAdapter;
  tenantId: string;
}

/**
 * Build the `redeemInvite` handler bound to a refs bag.
 *
 * Mirrors the legacy `chat.invite.redeem` manifest handler exactly: token
 * lookup, revoke/expiry checks, idempotent member probe, block check,
 * atomic claim/release, member create, best-effort grant.
 */
export function createRedeemInviteHandler(args: CreateRedeemInviteHandlerArgs) {
  const { refs, permissionsAdapter, tenantId } = args;
  return async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const userId = getUserId(params);
    const token = typeof params.token === 'string' ? params.token : '';
    const memberAdapter = refs.members;
    const roomAdapter = refs.rooms;
    const blockAdapter = refs.blocks;
    const inviteAdapter = refs.invites;

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

    await permissionsAdapter
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
  };
}

/**
 * Build the `claimInviteSlot` operation bound directly to a RoomInvite
 * adapter. Internal — the legacy manifest exposed it as a custom op with
 * no route. Used by `redeemInvite` via direct call.
 */
export function buildClaimInviteSlotOp(inviteAdapter: RoomInviteAdapter) {
  return async (params: { id?: string }) => {
    if (!params.id) return null;
    const invite = await inviteAdapter.getById(params.id);
    if (!invite) return null;
    if (invite.maxUses != null && invite.useCount >= invite.maxUses) return null;
    return inviteAdapter.update(invite.id, { useCount: invite.useCount + 1 });
  };
}

/** Build the refs-bound HTTP-form handler for `claimInviteSlot`. */
export function createClaimInviteSlotHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const params = (input ?? {}) as { id?: string };
    const inviteAdapter = refs.invites;
    if (!inviteAdapter) {
      throw new Error('[slingshot-chat] claimInviteSlot executed before adapters were captured');
    }
    return buildClaimInviteSlotOp(inviteAdapter)(params);
  };
}

/** Build the `releaseInviteSlot` op bound to a RoomInvite adapter. */
export function buildReleaseInviteSlotOp(inviteAdapter: RoomInviteAdapter) {
  return async (params: { id?: string }) => {
    if (!params.id) return null;
    const invite = await inviteAdapter.getById(params.id);
    if (!invite || invite.useCount <= 0) return null;
    return inviteAdapter.update(invite.id, { useCount: invite.useCount - 1 });
  };
}

/** Build the refs-bound HTTP-form handler for `releaseInviteSlot`. */
export function createReleaseInviteSlotHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const params = (input ?? {}) as { id?: string };
    const inviteAdapter = refs.invites;
    if (!inviteAdapter) {
      throw new Error(
        '[slingshot-chat] releaseInviteSlot executed before adapters were captured',
      );
    }
    return buildReleaseInviteSlotOp(inviteAdapter)(params);
  };
}

/**
 * Wrap a RoomInvite adapter so `claimInviteSlot` + `releaseInviteSlot` are
 * directly callable on the resolved adapter — used by `redeemInvite` and
 * by tests/fixtures that exercise the slot lifecycle without going
 * through HTTP.
 */
export function applyInviteSlotMethods(inviteAdapter: RoomInviteAdapter): BareEntityAdapter {
  const claim = buildClaimInviteSlotOp(inviteAdapter);
  const release = buildReleaseInviteSlotOp(inviteAdapter);
  return {
    ...inviteAdapter,
    claimInviteSlot: (params: { id: string }) => claim(params),
    releaseInviteSlot: (params: { id: string }) => release(params),
  } as unknown as BareEntityAdapter;
}

/**
 * Build the `claimDueReminders` op bound to a Reminder adapter. Lists
 * pending reminders, filters to those with `triggerAt <= now`, then
 * atomically flips `triggered: true`.
 */
export function buildClaimDueRemindersOp(reminderAdapter: ReminderAdapter) {
  return async (params: { limit?: number } = {}) => {
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
  };
}

/** Build the refs-bound HTTP-form handler for `claimDueReminders`. */
export function createClaimDueRemindersHandler(refs: ChatAdapterRefs) {
  return async (input: unknown) => {
    const params = (input ?? {}) as { limit?: number };
    const reminderAdapter = refs.reminders;
    if (!reminderAdapter) {
      throw new Error('[slingshot-chat] claimDueReminders executed before adapters were captured');
    }
    return buildClaimDueRemindersOp(reminderAdapter)(params);
  };
}

/**
 * Wrap a Reminder adapter so `claimDueReminders` is directly callable on
 * the resolved adapter — used by the reminder-delivery interval and by
 * test fixtures exercising the claim lifecycle without going through HTTP.
 */
export function applyClaimDueRemindersMethod(
  reminderAdapter: ReminderAdapter,
): BareEntityAdapter {
  const claim = buildClaimDueRemindersOp(reminderAdapter);
  return {
    ...reminderAdapter,
    claimDueReminders: (params: { limit: number }) => claim(params),
  } as unknown as BareEntityAdapter;
}

/**
 * Build a `ChatPluginState` snapshot from a captured refs bag, config, peer,
 * and permissions evaluator. Used by the package factory to publish the
 * runtime state slot during `setupRoutes`.
 *
 * @throws If any required adapter ref is missing — the package's entity
 *   `buildAdapter` callbacks failed to run.
 */
export function buildChatPluginStateSnapshot(args: {
  refs: ChatAdapterRefs;
  config: ChatPluginState['config'];
  permissions: PermissionsState;
  interactionsPeer: NonNullable<ChatPluginState['interactionsPeer']>;
}): ChatPluginState {
  const { refs, config, permissions, interactionsPeer } = args;
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
  return {
    rooms: refs.rooms,
    members: refs.members,
    messages: refs.messages,
    receipts: refs.receipts,
    reactions: refs.reactions,
    pins: refs.pins,
    blocks: refs.blocks,
    favorites: refs.favorites,
    invites: refs.invites,
    reminders: refs.reminders,
    config,
    interactionsPeer,
    evaluator: permissions.evaluator,
  };
}

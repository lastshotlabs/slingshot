// packages/slingshot-chat/src/types.ts
import type {
  AssetRef,
  ContactData,
  ContentFormat,
  EmbedData,
  LocationData,
  PaginatedResult,
  PermissionEvaluator,
  QuotePreview,
  StoreType,
  SystemEventData,
} from '@lastshotlabs/slingshot-core';

// ─── Entity model types ───────────────────────────────────────────────────────
// Hand-written to match entity field definitions — single source of truth.

/** A chat room. */
export interface Room {
  readonly id: string;
  readonly tenantId?: string | null;
  readonly name?: string | null;
  readonly type: RoomType;
  readonly encrypted: boolean;
  readonly retentionDays?: number | null;
  /** Optional room description (e.g. channel purpose). */
  readonly description?: string | null;
  /** Short topic line displayed in room header. */
  readonly topic?: string | null;
  /** URL of the room's avatar image. */
  readonly avatarUrl?: string | null;
  /** Whether the room is archived. Archived rooms reject new messages. */
  readonly archived: boolean;
  /** Timestamp when the room was archived. */
  readonly archivedAt?: string | null;
  readonly lastMessageAt?: string | null;
  readonly lastMessageId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A room membership record. */
export interface RoomMember {
  readonly id: string;
  readonly roomId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly lastReadAt?: string | null;
  readonly mutedUntil?: string | null;
  readonly nickname?: string | null;
  readonly notifyOn: NotifyPreference;
  readonly joinedAt: string;
}

/** A chat message. */
export interface Message {
  readonly id: string;
  readonly roomId: string;
  readonly authorId?: string | null;
  readonly body: string;
  readonly type: MessageType;
  /** Content format: `'plain'` or `'markdown'` (default). */
  readonly format: ContentFormat;
  readonly replyToId?: string | null;
  readonly editedAt?: string | null;
  readonly deletedAt?: string | null;
  /** Explicit user-ID mentions parsed from body or provided by client. */
  readonly mentions?: readonly string[];
  /** Broadcast mention tokens (`'everyone'` or `'here'`). */
  readonly broadcastMentions?: readonly ('everyone' | 'here')[];
  /** Role IDs mentioned via `<@&roleId>` tokens. */
  readonly mentionedRoleIds?: readonly string[];
  /** File/media attachments. */
  readonly attachments?: readonly AssetRef[];
  /** Resolved link-preview embeds. */
  readonly embeds?: readonly EmbedData[];
  /** Quoted message ID for inline quotes. */
  readonly quotedMessageId?: string;
  /** Snapshot of the quoted message content. */
  readonly quotePreview?: QuotePreview;
  /** Poll entity ID when a poll is attached to this message. */
  readonly pollId?: string;
  /** Sticker asset ID for sticker messages. */
  readonly stickerId?: string;
  /** Location data for location-sharing messages. */
  readonly location?: LocationData;
  /** Contact card data for contact-sharing messages. */
  readonly contact?: ContactData;
  /** Structured event data for system messages. */
  readonly systemEvent?: SystemEventData;
  /** Application-specific metadata (opaque to the framework). */
  readonly appMetadata?: unknown;
  readonly components?: unknown;
  /** Number of direct replies to this message. */
  readonly replyCount: number;
  /** ID of the original message when this is a forward. */
  readonly forwardedFromId?: string | null;
  /** Scheduled delivery time. */
  readonly scheduledAt?: string | null;
  /** Whether a scheduled message has been delivered. */
  readonly scheduledDelivered: boolean;
  /** Denormalized author display name, snapshotted at create time. */
  readonly authorName?: string | null;
  readonly deliveredTo: number;
  readonly readBy: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A read receipt. */
export interface ReadReceipt {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly roomId: string;
  readonly readAt: string;
}

/** An emoji reaction on a message. */
export interface MessageReaction {
  readonly id: string;
  readonly messageId: string;
  readonly roomId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly createdAt: string;
}

/** A pinned message in a room. */
export interface Pin {
  readonly id: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly pinnedBy: string;
  readonly pinnedAt: string;
}

/** A user block relationship. */
export interface Block {
  readonly id: string;
  readonly blockerId: string;
  readonly blockedId: string;
  readonly createdAt: string;
}

/** A user's favorited room. */
export interface FavoriteRoom {
  readonly id: string;
  readonly userId: string;
  readonly roomId: string;
  readonly sortOrder: number;
  readonly createdAt: string;
}

/** A room invite link. */
export interface RoomInvite {
  readonly id: string;
  readonly roomId: string;
  readonly createdBy: string;
  readonly token: string;
  readonly maxUses?: number | null;
  readonly useCount: number;
  readonly expiresAt?: string | null;
  readonly revoked: boolean;
  readonly createdAt: string;
}

/** A user reminder. */
export interface Reminder {
  readonly id: string;
  readonly userId: string;
  readonly roomId: string;
  readonly messageId?: string | null;
  readonly note?: string | null;
  readonly triggerAt: string;
  readonly triggered: boolean;
  readonly createdAt: string;
}

// ─── Create / update input types ─────────────────────────────────────────────
// Fields with auto-defaults (uuid, now) are optional. Immutable + auto fields
// excluded from update inputs.

/** Input for creating a Room. */
export interface CreateRoomInput {
  id?: string;
  tenantId?: string | null;
  name?: string | null;
  type: RoomType;
  encrypted?: boolean;
  retentionDays?: number | null;
  description?: string | null;
  topic?: string | null;
  avatarUrl?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  lastMessageAt?: string | null;
  lastMessageId?: string | null;
}

/** Input for updating a Room. */
export interface UpdateRoomInput {
  name?: string | null;
  tenantId?: string | null;
  encrypted?: boolean;
  retentionDays?: number | null;
  description?: string | null;
  topic?: string | null;
  avatarUrl?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  lastMessageAt?: string | null;
  lastMessageId?: string | null;
}

/** Input for creating a RoomMember. */
export interface CreateMemberInput {
  roomId: string;
  userId: string;
  role?: MemberRole;
  lastReadAt?: string | null;
  mutedUntil?: string | null;
  nickname?: string | null;
  notifyOn?: NotifyPreference;
}

/** Input type for `RoomMemberAdapter.create()`. Structural alias of `CreateMemberInput`. */
export type AddMemberInput = CreateMemberInput;

/** Input for updating a RoomMember (mutable fields only). */
export interface UpdateMemberInput {
  role?: MemberRole;
  lastReadAt?: string | null;
  mutedUntil?: string | null;
  nickname?: string | null;
  notifyOn?: NotifyPreference;
}

/** Input for creating a Message. */
export interface CreateMessageInput {
  id?: string;
  roomId: string;
  authorId?: string | null;
  body: string;
  type?: MessageType;
  format?: ContentFormat;
  replyToId?: string | null;
  editedAt?: string | null;
  deletedAt?: string | null;
  mentions?: readonly string[];
  broadcastMentions?: readonly ('everyone' | 'here')[];
  mentionedRoleIds?: readonly string[];
  attachments?: readonly AssetRef[];
  embeds?: readonly EmbedData[];
  quotedMessageId?: string;
  quotePreview?: QuotePreview;
  pollId?: string;
  stickerId?: string;
  location?: LocationData;
  contact?: ContactData;
  systemEvent?: SystemEventData;
  appMetadata?: unknown;
  components?: unknown;
  replyCount?: number;
  forwardedFromId?: string | null;
  scheduledAt?: string | null;
  scheduledDelivered?: boolean;
  authorName?: string | null;
  deliveredTo?: number;
  readBy?: number;
}

/** Input for updating a Message (mutable fields only). */
export interface UpdateMessageInput {
  body?: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  mentions?: readonly string[];
  broadcastMentions?: readonly ('everyone' | 'here')[];
  mentionedRoleIds?: readonly string[];
  attachments?: readonly AssetRef[];
  embeds?: readonly EmbedData[];
  quotePreview?: QuotePreview;
  appMetadata?: unknown;
  components?: unknown;
  scheduledDelivered?: boolean;
  deliveredTo?: number;
  readBy?: number;
}

// ─── Unread count ────────────────────────────────────────────────────────────

/** A single room's unread message count. */
export interface UnreadCountEntry {
  readonly roomId: string;
  readonly count: number;
}

/** Response from the `unreadCount` operation. */
export interface UnreadCountResponse {
  readonly counts: readonly UnreadCountEntry[];
}

// ─── Enum / literal types ─────────────────────────────────────────────────────

/** Room topology type. */
export type RoomType = 'dm' | 'group' | 'broadcast';
/** Member role within a room. */
export type MemberRole = 'owner' | 'admin' | 'member';
/** Notification preference for a room membership. */
export type NotifyPreference = 'all' | 'mentions' | 'none';
/** Message content type. */
export type MessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'gif'
  | 'sticker'
  | 'voice'
  | 'location'
  | 'contact'
  | 'system';

// ─── Entity adapter types ─────────────────────────────────────────────────────
// Hand-written to match the operations defined in entity configs.
// Each adapter has CRUD methods (from EntityAdapter) plus typed operation methods.

/** Entity adapter for Room — CRUD + room-specific operations. */
export interface RoomAdapter {
  create(input: CreateRoomInput): Promise<Room>;
  getById(id: string): Promise<Room | null>;
  update(id: string, input: UpdateRoomInput): Promise<Room | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<Room>>;
  clear(): Promise<void>;
  /** Look up a DM room by its deterministic ID. */
  findDm(params: { id: string }): Promise<Room | null>;
  /** Update `lastMessageAt` and `lastMessageId` after a message is created. */
  updateLastMessage(
    match: { id: string },
    data: { lastMessageAt?: string | null; lastMessageId?: string | null },
  ): Promise<Room | null>;
  /** Archive a room. */
  archiveRoom(
    match: { id: string },
    data: { archived?: boolean; archivedAt?: string | null },
  ): Promise<Room | null>;
  /** Unarchive a room. */
  unarchiveRoom(
    match: { id: string },
    data: { archived?: boolean; archivedAt?: string | null },
  ): Promise<Room | null>;
}

/** Entity adapter for RoomMember — CRUD + membership operations. */
export interface RoomMemberAdapter {
  create(input: CreateMemberInput): Promise<RoomMember>;
  getById(id: string): Promise<RoomMember | null>;
  update(id: string, input: UpdateMemberInput): Promise<RoomMember | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<RoomMember>>;
  clear(): Promise<void>;
  /** All members in a room. */
  listByRoom(params: { roomId: string }): Promise<PaginatedResult<RoomMember>>;
  /** All memberships for a user. */
  listByUser(params: { userId: string }): Promise<PaginatedResult<RoomMember>>;
  /** Single membership lookup by composite key. */
  findMember(params: { roomId: string; userId: string }): Promise<RoomMember | null>;
  /** Update `lastReadAt` for a member. */
  updateLastRead(
    match: { roomId: string; userId: string },
    data: { lastReadAt?: string | null },
  ): Promise<RoomMember | null>;
  /** Count members in a room. */
  countMembers(params?: Record<string, unknown>): Promise<unknown>;
  /** Per-room unread message counts for the authenticated user. */
  unreadCount(params: Record<string, unknown>): Promise<UnreadCountResponse>;
}

/** Entity adapter for Message — CRUD + message-specific operations. */
export interface MessageAdapter {
  create(input: CreateMessageInput): Promise<Message>;
  getById(id: string): Promise<Message | null>;
  update(id: string, input: UpdateMessageInput): Promise<Message | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<Message>>;
  clear(): Promise<void>;
  /** Paginated messages in a room, ordered by `createdAt`. */
  listByRoom(params: {
    roomId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResult<Message>>;
  /** Increment `deliveredTo` counter. */
  incrementDelivered(
    match: { id: string },
    data: { deliveredTo?: number },
  ): Promise<Message | null>;
  /** Increment `readBy` counter. */
  incrementReadBy(match: { id: string }, data: { readBy?: number }): Promise<Message | null>;
  updateComponents(match: { id: string }, data: { components?: unknown }): Promise<Message | null>;
  /** Paginated replies to a message within a room. */
  listReplies(params: {
    messageId: string;
    roomId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResult<Message>>;
  /** Atomically increment `replyCount` on a parent message. */
  incrementReplyCount(id: string): Promise<Message | null>;
  /** Atomically decrement `replyCount` on a parent message. */
  decrementReplyCount(id: string): Promise<Message | null>;
  /** Forward a message to another room. */
  forwardMessage(params: Record<string, unknown>): Promise<{ message: Message }>;
  /** Full-text search within a room. */
  searchMessages(params: Record<string, unknown>): Promise<PaginatedResult<Message>>;
  /** Attach resolved link-preview embeds to a message. */
  attachEmbeds(match: { id: string }, data: { embeds?: unknown }): Promise<Message | null>;
  /** Internal: atomic batch claim of due scheduled messages. */
  claimDueScheduledMessages(params: { limit: number }): Promise<Message[]>;
}

/** Entity adapter for ReadReceipt — CRUD + receipt operations. */
export interface ReadReceiptAdapter {
  create(input: {
    messageId: string;
    userId: string;
    roomId: string;
    readAt?: string;
  }): Promise<ReadReceipt>;
  getById(id: string): Promise<ReadReceipt | null>;
  update(id: string, input: Record<string, unknown>): Promise<ReadReceipt | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<ReadReceipt>>;
  clear(): Promise<void>;
  /** Insert or update a receipt keyed on `(userId, messageId)`. */
  upsertReceipt(data: {
    userId: string;
    messageId: string;
    roomId: string;
    readAt?: string;
  }): Promise<ReadReceipt>;
  /** Most recent receipt for a user in a room. */
  latestForUserInRoom(params: { userId: string; roomId: string }): Promise<ReadReceipt | null>;
  /** All receipts for a specific message. */
  listByMessage(params: { messageId: string }): Promise<PaginatedResult<ReadReceipt>>;
}

/** Entity adapter for MessageReaction — CRUD + reaction operations. */
export interface MessageReactionAdapter {
  create(input: {
    messageId: string;
    roomId: string;
    userId: string;
    emoji: string;
  }): Promise<MessageReaction>;
  getById(id: string): Promise<MessageReaction | null>;
  update(id: string, input: Record<string, unknown>): Promise<MessageReaction | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<MessageReaction>>;
  clear(): Promise<void>;
  /** Upsert keyed on `(userId, messageId, emoji)` — idempotent. */
  addReaction(data: {
    userId: string;
    messageId: string;
    roomId: string;
    emoji: string;
  }): Promise<MessageReaction>;
  /** Delete a user's emoji reaction from a message. */
  removeReaction(params: { userId: string; messageId: string; emoji: string }): Promise<number>;
  /** Count reactions for a specific emoji on a message. */
  countByEmoji(params?: Record<string, unknown>): Promise<unknown>;
  /** All emoji reaction aggregates for a message. */
  listAggregated(params?: Record<string, unknown>): Promise<unknown>;
  /** Check if a user has reacted with a specific emoji. */
  hasReacted(params: { userId: string; messageId: string; emoji: string }): Promise<boolean>;
}

/** Entity adapter for Pin — CRUD + pin operations. */
export interface PinAdapter {
  create(input: { roomId: string; messageId: string; pinnedBy: string }): Promise<Pin>;
  getById(id: string): Promise<Pin | null>;
  update(id: string, input: Record<string, unknown>): Promise<Pin | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<Pin>>;
  clear(): Promise<void>;
  /** All pins in a room. */
  listByRoom(params: { roomId: string }): Promise<PaginatedResult<Pin>>;
  /** Delete the pin for a `(roomId, messageId)` pair. */
  unpin(params: { roomId: string; messageId: string }): Promise<number>;
  /** Check if a message is currently pinned. */
  isPinned(params: { roomId: string; messageId: string }): Promise<boolean>;
}

/** Entity adapter for Block — CRUD + block operations. */
export interface BlockAdapter {
  create(input: { blockerId: string; blockedId: string }): Promise<Block>;
  getById(id: string): Promise<Block | null>;
  update(id: string, input: Record<string, unknown>): Promise<Block | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<Block>>;
  clear(): Promise<void>;
  /** Check if a block exists between two users. */
  isBlocked(params: { blockerId: string; blockedId: string }): Promise<boolean>;
  /** All blocks initiated by a given user. */
  listByBlocker(params: { blockerId: string }): Promise<PaginatedResult<Block>>;
  /** Delete the block for a `(blockerId, blockedId)` pair. */
  unblockUser(params: { blockerId: string; blockedId: string }): Promise<number>;
}

/** Entity adapter for FavoriteRoom — CRUD + favorites operations. */
export interface FavoriteRoomAdapter {
  create(input: { userId: string; roomId: string; sortOrder?: number }): Promise<FavoriteRoom>;
  getById(id: string): Promise<FavoriteRoom | null>;
  update(id: string, input: Record<string, unknown>): Promise<FavoriteRoom | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<FavoriteRoom>>;
  clear(): Promise<void>;
  /** All favorited rooms for a user. */
  listByUser(params: { userId: string }): Promise<PaginatedResult<FavoriteRoom>>;
  /** Check if a user has favorited a specific room. */
  isFavorite(params: { userId: string; roomId: string }): Promise<boolean>;
  /** Remove the favorite for a `(userId, roomId)` pair. */
  unfavorite(params: { userId: string; roomId: string }): Promise<number>;
  /** Update `sortOrder` for a `(userId, roomId)` pair. */
  updateOrder(
    match: { userId: string; roomId: string },
    data: { sortOrder: number },
  ): Promise<FavoriteRoom | null>;
}

/** Entity adapter for RoomInvite — CRUD + invite operations. */
export interface RoomInviteAdapter {
  create(input: {
    roomId: string;
    createdBy: string;
    token: string;
    maxUses?: number | null;
    expiresAt?: string | null;
  }): Promise<RoomInvite>;
  getById(id: string): Promise<RoomInvite | null>;
  update(id: string, input: Record<string, unknown>): Promise<RoomInvite | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<RoomInvite>>;
  clear(): Promise<void>;
  /** Capability-based lookup by token. */
  findByToken(params: { token: string }): Promise<RoomInvite | null>;
  /** Redeem an invite. Handler wired by plugin. */
  redeemInvite(params: Record<string, unknown>): Promise<unknown>;
  /** Revoke an invite. */
  revokeInvite(match: { id: string }): Promise<RoomInvite | null>;
  /** All invites for a room. */
  listByRoom(params: { roomId: string }): Promise<PaginatedResult<RoomInvite>>;
  /** Internal: atomic slot claim. */
  claimInviteSlot(params: { id: string }): Promise<RoomInvite | null>;
  /** Internal: compensating slot release. */
  releaseInviteSlot(params: { id: string }): Promise<RoomInvite | null>;
}

/** Entity adapter for Reminder — CRUD + reminder operations. */
export interface ReminderAdapter {
  create(input: {
    userId: string;
    roomId: string;
    messageId?: string | null;
    note?: string | null;
    triggerAt: string;
  }): Promise<Reminder>;
  getById(id: string): Promise<Reminder | null>;
  update(id: string, input: Record<string, unknown>): Promise<Reminder | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<Reminder>>;
  clear(): Promise<void>;
  /** Untriggered reminders for the authenticated user. */
  listPending(params: Record<string, unknown>): Promise<PaginatedResult<Reminder>>;
  /** Internal: atomic batch claim of due reminders. */
  claimDueReminders(params: { limit: number }): Promise<Reminder[]>;
}

// ─── Plugin state ─────────────────────────────────────────────────────────────

/**
 * The object stored in `SlingshotContext.pluginState` under the key `'slingshot-chat'`.
 *
 * Access from other plugins or routes:
 * ```ts
 * const chatState = ctx.pluginState.get(CHAT_PLUGIN_STATE_KEY) as ChatPluginState
 * ```
 */
export interface ChatPluginState {
  readonly rooms: RoomAdapter;
  readonly members: RoomMemberAdapter;
  readonly messages: MessageAdapter;
  readonly receipts: ReadReceiptAdapter;
  readonly reactions: MessageReactionAdapter;
  readonly pins: PinAdapter;
  readonly blocks: BlockAdapter;
  readonly favorites: FavoriteRoomAdapter;
  readonly invites?: RoomInviteAdapter;
  readonly reminders?: ReminderAdapter;
  readonly config: Readonly<ChatPluginConfig>;
  readonly interactionsPeer?: {
    readonly peerKind: 'chat';
    resolveMessageByKindAndId(
      kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
      id: string,
    ): Promise<{ readonly components?: unknown } | null>;
    updateComponents(
      kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
      id: string,
      components: ReadonlyArray<unknown>,
    ): Promise<void>;
  };
  /**
   * The shared `PermissionEvaluator` from `slingshot-permissions`.
   * Route handlers call `evaluator.can(subject, action, scope)` for access control.
   */
  readonly evaluator: PermissionEvaluator;
}

// ─── Plugin config ────────────────────────────────────────────────────────────

/**
 * Permission roles configuration for chat operations.
 *
 * Each field accepts an array of role strings allowed to perform the operation.
 * If omitted, no role restriction is applied.
 */
export interface ChatPermissionsConfig {
  /** Roles that can create group or broadcast rooms. Default: any authenticated user. */
  createRoom?: readonly string[];
  /** Roles that can send messages in a room they are a member of. Default: any member. */
  sendMessage?: readonly string[];
  /** Roles that can delete any message in a room (beyond their own). */
  deleteMessage?: readonly string[];
  /** Roles that can pin messages. Default: `['admin']`. */
  pinMessage?: readonly string[];
  /** Roles that can add members to a group room. Default: `['admin']`. */
  addMember?: readonly string[];
}

/**
 * Disable message-body encryption.
 *
 * This is the default when `ChatPluginConfig.encryption` is omitted.
 */
export interface ChatNoEncryptionConfig {
  readonly provider: 'none';
}

/**
 * AES-GCM encryption config for encrypted rooms.
 *
 * The key must be a base64-encoded raw AES key (16, 24, or 32 bytes). The
 * room ID is bound into the cipher as authenticated data so ciphertext cannot
 * be replayed across rooms.
 */
export interface ChatAesGcmEncryptionConfig {
  readonly provider: 'aes-gcm';
  readonly keyBase64: string;
  readonly aadPrefix?: string;
}

/** Manifest-safe encryption config for `createChatPlugin()`. */
export type ChatEncryptionConfig = ChatNoEncryptionConfig | ChatAesGcmEncryptionConfig;

/**
 * Configuration for `createChatPlugin()`.
 *
 * @example
 * ```ts
 * createChatPlugin({
 *   storeType: 'postgres',
 *   mountPath: '/chat',
 *   permissions: { createRoom: ['admin', 'moderator'] },
 * })
 * ```
 */
export interface ChatPluginConfig {
  /** Persistence backend to use. */
  readonly storeType: StoreType;
  /**
   * Tenant ID for all RBAC grants and `evaluator.can()` checks.
   * @default 'default'
   */
  readonly tenantId?: string;
  /**
   * URL prefix for all HTTP routes.
   * @default '/chat'
   */
  readonly mountPath?: string;
  /** Permission role configuration. */
  readonly permissions?: ChatPermissionsConfig;
  /**
   * Maximum messages returned per paginated list request.
   * @default 50
   */
  readonly pageSize?: number;
  /**
   * Enable room presence tracking.
   * @default true
   */
  readonly enablePresence?: boolean;
  /**
   * Manifest-safe encryption provider for encrypted rooms.
   *
   * When omitted, encrypted rooms store plaintext until an encryption provider is
   * configured. `provider: 'aes-gcm'` enables server-side at-rest encryption.
   */
  readonly encryption?: ChatEncryptionConfig;
}

// ─── WS payloads ─────────────────────────────────────────────────────────────

/** Payload sent to clients on `chat.message.created`. */
export type ChatMessageCreatedPayload = Message;

/** Payload sent to clients on `chat.message.updated`. */
export type ChatMessageUpdatedPayload = Message;

/** Payload sent to clients on `chat.message.deleted`. */
export interface ChatMessageDeletedPayload {
  readonly id: string;
  readonly roomId: string;
  readonly deletedAt: string;
}

/** Payload for the `chat.typing` incoming WS event (client → server). */
export interface ChatTypingPayload {
  readonly roomId: string;
}

/** Payload for the `chat.read` incoming WS event (client → server). */
export interface ChatReadPayload {
  readonly roomId: string;
  /** The last message ID the client has seen. */
  readonly messageId: string;
}

/** Payload broadcast on `chat.read` (server → clients). */
export interface ChatReadBroadcastPayload {
  readonly userId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly readAt: string;
}

/**
 * Payload emitted on the `chat:read.created` bus event when a read receipt is recorded.
 *
 * Emitted by the `chat.read` WebSocket handler after upserting a receipt row.
 * The WS forward config picks this up and broadcasts `chat.read` to room members.
 */
export interface ReadReceiptCreatedPayload {
  readonly receipt: ReadReceipt;
  readonly userId: string;
  readonly roomId: string;
}

/**
 * Payload for the `chat.message.reaction` WS event sent to clients.
 *
 * Forwarded from both `chat:message.reaction.added` and `chat:message.reaction.removed`
 * bus events. The `added` flag distinguishes the two.
 */
export interface ReactionCountPayload {
  readonly messageId: string;
  readonly roomId: string;
  readonly emoji: string;
  readonly count: number;
  /** `true` when a reaction was added; `false` when removed. */
  readonly added: boolean;
}

/** Payload for the `chat.ping` keepalive WS event. */
export interface ChatPingPayload {
  readonly ts: number;
}

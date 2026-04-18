// packages/slingshot-chat/src/index.ts
import './events';

/**
 * @lastshotlabs/slingshot-chat
 *
 * Framework-level reusable chat plugin for the Slingshot framework.
 * Provides rooms, messages, members, real-time delivery, DM topology,
 * broadcast channels, and full management (mute, block, favorites, pins).
 *
 * @example
 * ```ts
 * import { createChatPlugin } from '@lastshotlabs/slingshot-chat'
 *
 * const app = await createApp({
 *   plugins: [
 *     createChatPlugin({
 *       storeType: 'postgres',
 *       mountPath: '/chat',
 *     }),
 *   ],
 * })
 * ```
 */

export type {
  // Entity types
  Room,
  RoomType,
  CreateRoomInput,
  UpdateRoomInput,
  RoomMember,
  MemberRole,
  NotifyPreference,
  CreateMemberInput,
  AddMemberInput,
  UpdateMemberInput,
  Message,
  MessageType,
  CreateMessageInput,
  UpdateMessageInput,
  ReadReceipt,
  MessageReaction,
  Pin,
  Block,
  FavoriteRoom,
  RoomInvite,
  Reminder,
  // Entity adapter interfaces
  RoomAdapter,
  RoomMemberAdapter,
  MessageAdapter,
  ReadReceiptAdapter,
  MessageReactionAdapter,
  PinAdapter,
  BlockAdapter,
  FavoriteRoomAdapter,
  RoomInviteAdapter,
  ReminderAdapter,
  // Plugin
  ChatPluginState,
  ChatPluginConfig,
  ChatPermissionsConfig,
  ChatEncryptionConfig,
  ChatNoEncryptionConfig,
  ChatAesGcmEncryptionConfig,
  // WS payloads
  ChatMessageCreatedPayload,
  ChatMessageUpdatedPayload,
  ChatMessageDeletedPayload,
  ChatTypingPayload,
  ChatReadPayload,
  ChatReadBroadcastPayload,
  ChatPingPayload,
  ReadReceiptCreatedPayload,
  ReactionCountPayload,
} from './types';

/**
 * Create and return a configured slingshot-chat `SlingshotPlugin`.
 *
 * @example
 * ```ts
 * import { createChatPlugin } from '@lastshotlabs/slingshot-chat'
 *
 * const app = await createApp({
 *   plugins: [
 *     createChatPlugin({ storeType: 'memory', mountPath: '/chat' }),
 *   ],
 * })
 * ```
 */
export { createChatPlugin } from './plugin';
export { chatManifest } from './manifest/chatManifest';

/**
 * Plugin state key for looking up chat state in `ctx.pluginState`.
 *
 * @example
 * ```ts
 * import { CHAT_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-chat'
 * const chatState = ctx.pluginState.get(CHAT_PLUGIN_STATE_KEY) as ChatPluginState
 * ```
 */
export { CHAT_PLUGIN_STATE_KEY } from './state';

/**
 * Error thrown when a repository backend operation is not yet implemented.
 * Catch this in tests to verify stub backends throw correctly.
 */
export { ChatRepoNotImplementedError } from './factories/errors';

/**
 * Encryption key bundle type for v2 Signal protocol (v1: stub shape).
 * @status PENDING
 */
export type { UserKeyBundle } from './encryption/stub';

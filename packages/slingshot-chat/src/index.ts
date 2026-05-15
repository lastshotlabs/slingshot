// packages/slingshot-chat/src/index.ts
import './events';

/**
 * `@lastshotlabs/slingshot-chat` is Slingshot's chat domain package. It provides
 * rooms, memberships, messages, reactions, read receipts, pins, blocks,
 * favorites, invites, reminders, scheduled messages, and the WebSocket realtime
 * surface — authored via `definePackage(...)` and consumed through
 * `createApp({ packages: [createChatPackage(...)] })`.
 *
 * @example
 * ```ts
 * import { createChatPackage } from '@lastshotlabs/slingshot-chat';
 *
 * createChatPackage({
 *   storeType: 'postgres',
 *   mountPath: '/chat',
 * });
 * ```
 */

/**
 * Entity record types, create/update inputs, adapter contracts, plugin runtime
 * state, plugin config, encryption config variants, and WebSocket payload shapes.
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
 * Create and return a configured chat `SlingshotPackageDefinition`.
 *
 * @example
 * ```ts
 * import { createChatPackage } from '@lastshotlabs/slingshot-chat';
 *
 * createChatPackage({ storeType: 'memory', mountPath: '/chat' });
 * ```
 */
export { createChatPackage } from './plugin';

/**
 * Provider-owned package contract. Cross-package consumers resolve
 * `ChatInteractionsPeerCap` through `ctx.capabilities.require(...)` instead
 * of reaching into plugin state.
 */
export { Chat, ChatEntities, ChatInteractionsPeerCap } from './public';
/**
 * Cross-package peer surface used to resolve chat-owned message trees and apply
 * component updates returned by interaction dispatchers.
 */
export type { ChatInteractionsPeer } from './public';

/**
 * Plugin state key under which the chat package publishes a partial
 * `ChatPluginState` (currently `interactionsPeer`). Load-bearing internal
 * infrastructure for the `probeChatPeer` / `getPublishedInteractionsPeerOrNull`
 * bridge in `slingshot-interactions`.
 *
 * @internal Cross-package code should resolve `ChatInteractionsPeerCap` via
 * `ctx.capabilities.require(...)` instead of reading this slot directly.
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

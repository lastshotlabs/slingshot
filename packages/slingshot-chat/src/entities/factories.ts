// packages/slingshot-chat/src/entities/factories.ts
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { Block, blockOperations } from './block';
import { FavoriteRoom, favoriteRoomOperations } from './favorite-room';
import { Message, messageOperations } from './message';
import { MessageReaction, messageReactionOperations } from './message-reaction';
import { Pin, pinOperations } from './pin';
import { ReadReceipt, readReceiptOperations } from './read-receipt';
import { Reminder, reminderOperations } from './reminder';
import { Room, roomOperations } from './room';
import { RoomInvite, roomInviteOperations } from './room-invite';
import { RoomMember, roomMemberOperations } from './room-member';

/**
 * `RepoFactories` dispatch map for `Room`.
 *
 * Dispatch to the right store adapter via `resolveRepo(roomFactories, storeType, infra)`.
 * For the correct `listForUser` semantics in memory mode, route handlers combine
 * `roomFactories` with `memberFactories` at the route level.
 */
export const roomFactories = createEntityFactories(Room, roomOperations.operations);

/**
 * `RepoFactories` dispatch map for `RoomMember`.
 */
export const memberFactories = createEntityFactories(RoomMember, roomMemberOperations.operations);

/**
 * `RepoFactories` dispatch map for `Message`.
 */
export const messageFactories = createEntityFactories(Message, messageOperations.operations);

/**
 * `RepoFactories` dispatch map for `ReadReceipt`.
 */
export const receiptFactories = createEntityFactories(
  ReadReceipt,
  readReceiptOperations.operations,
);

/**
 * `RepoFactories` dispatch map for `MessageReaction`.
 */
export const reactionFactories = createEntityFactories(
  MessageReaction,
  messageReactionOperations.operations,
);

/**
 * `RepoFactories` dispatch map for `Pin`.
 */
export const pinFactories = createEntityFactories(Pin, pinOperations.operations);

/**
 * `RepoFactories` dispatch map for `Block`.
 */
export const blockFactories = createEntityFactories(Block, blockOperations.operations);

/**
 * `RepoFactories` dispatch map for `FavoriteRoom`.
 */
export const favoriteRoomFactories = createEntityFactories(
  FavoriteRoom,
  favoriteRoomOperations.operations,
);

/**
 * `RepoFactories` dispatch map for `RoomInvite`.
 */
export const roomInviteFactories = createEntityFactories(
  RoomInvite,
  roomInviteOperations.operations,
);

/**
 * `RepoFactories` dispatch map for `Reminder`.
 */
export const reminderFactories = createEntityFactories(Reminder, reminderOperations.operations);

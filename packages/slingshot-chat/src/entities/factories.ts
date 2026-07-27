// packages/slingshot-chat/src/entities/factories.ts
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
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

const roomBaseOperations = {
  findDm: roomOperations.operations.findDm,
  updateLastMessage: roomOperations.operations.updateLastMessage,
  archiveRoom: roomOperations.operations.archiveRoom,
  unarchiveRoom: roomOperations.operations.unarchiveRoom,
};
const memberBaseOperations = {
  listByRoom: roomMemberOperations.operations.listByRoom,
  listByUser: roomMemberOperations.operations.listByUser,
  findMember: roomMemberOperations.operations.findMember,
  updateLastRead: roomMemberOperations.operations.updateLastRead,
  countMembers: roomMemberOperations.operations.countMembers,
  leave: roomMemberOperations.operations.leave,
};
const messageBaseOperations = {
  listByRoom: messageOperations.operations.listByRoom,
  listReplies: messageOperations.operations.listReplies,
  searchMessages: messageOperations.operations.searchMessages,
  incrementReplyCount: messageOperations.operations.incrementReplyCount,
  decrementReplyCount: messageOperations.operations.decrementReplyCount,
  incrementDelivered: messageOperations.operations.incrementDelivered,
  incrementReadBy: messageOperations.operations.incrementReadBy,
  updateComponents: messageOperations.operations.updateComponents,
  attachEmbeds: messageOperations.operations.attachEmbeds,
  attachMentions: messageOperations.operations.attachMentions,
};
const roomInviteBaseOperations = {
  findByToken: roomInviteOperations.operations.findByToken,
  revokeInvite: roomInviteOperations.operations.revokeInvite,
  listByRoom: roomInviteOperations.operations.listByRoom,
};
const reminderBaseOperations = {
  listPending: reminderOperations.operations.listPending,
};

/**
 * `RepoFactories` dispatch map for `Room`.
 *
 * Dispatch to the right store adapter via `resolveRepo(roomFactories, storeType, infra)`.
 * For the correct `listForUser` semantics in memory mode, route handlers combine
 * `roomFactories` with `memberFactories` at the route level.
 */
export const roomFactories = createEntityFactories(Room, roomBaseOperations);

/**
 * `RepoFactories` dispatch map for `RoomMember`.
 */
export const memberFactories = createEntityFactories(RoomMember, memberBaseOperations);

/**
 * `RepoFactories` dispatch map for `Message`.
 */
export const messageFactories = createEntityFactories(Message, messageBaseOperations);

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
export const roomInviteFactories = createEntityFactories(RoomInvite, roomInviteBaseOperations);

/**
 * `RepoFactories` dispatch map for `Reminder`.
 */
export const reminderFactories = createEntityFactories(Reminder, reminderBaseOperations);

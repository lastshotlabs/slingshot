import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { Block, blockOperations } from '../entities/block';
import { FavoriteRoom, favoriteRoomOperations } from '../entities/favorite-room';
import { Message, messageOperations } from '../entities/message';
import { MessageReaction, messageReactionOperations } from '../entities/message-reaction';
import { Pin, pinOperations } from '../entities/pin';
import { ReadReceipt, readReceiptOperations } from '../entities/read-receipt';
import { Reminder, reminderOperations } from '../entities/reminder';
import { Room, roomOperations } from '../entities/room';
import { RoomInvite, roomInviteOperations } from '../entities/room-invite';
import { RoomMember, roomMemberOperations } from '../entities/room-member';

const roomChannels = {
  channels: {
    live: {
      auth: 'userAuth' as const,
      permission: {
        requires: 'chat:room.read',
      },
      presence: true,
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

/**
 * Manifest export for the persisted Slingshot chat resources.
 *
 * Room orchestration, notifications, schedulers, encryption stub routes, and
 * WS incoming dispatch remain package-owned runtime behavior resolved through
 * `createChatManifestRuntime()`.
 */
export const chatManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'chat',
  hooks: {
    afterAdapters: [{ handler: 'chat.captureAdapters' }],
  },
  entities: {
    Room: entityConfigToManifestEntry(Room, {
      operations: roomOperations.operations,
      channels: roomChannels,
      operationOverrides: {
        findOrCreateDm: {
          kind: 'custom',
          handler: 'chat.room.findOrCreateDm',
          http: { method: 'post' },
        },
      },
    }),
    RoomMember: entityConfigToManifestEntry(RoomMember, {
      operations: roomMemberOperations.operations,
      operationOverrides: {
        unreadCount: {
          kind: 'custom',
          handler: 'chat.member.unreadCount',
          http: { method: 'get', path: 'unread-count' },
        },
      },
    }),
    Message: entityConfigToManifestEntry(Message, {
      operations: messageOperations.operations,
      adapterTransforms: [{ handler: 'chat.message.editedAt' }, { handler: 'chat.message.cipher' }],
      operationOverrides: {
        forwardMessage: {
          kind: 'custom',
          handler: 'chat.message.forward',
          http: { method: 'post', path: 'forward' },
        },
        claimDueScheduledMessages: {
          kind: 'custom',
          handler: 'chat.message.claimDueScheduledMessages',
        },
      },
    }),
    ReadReceipt: entityConfigToManifestEntry(ReadReceipt, {
      operations: readReceiptOperations.operations,
    }),
    MessageReaction: entityConfigToManifestEntry(MessageReaction, {
      operations: messageReactionOperations.operations,
    }),
    Pin: entityConfigToManifestEntry(Pin, {
      operations: pinOperations.operations,
    }),
    Block: entityConfigToManifestEntry(Block, {
      operations: blockOperations.operations,
    }),
    FavoriteRoom: entityConfigToManifestEntry(FavoriteRoom, {
      operations: favoriteRoomOperations.operations,
    }),
    RoomInvite: entityConfigToManifestEntry(RoomInvite, {
      operations: roomInviteOperations.operations,
      operationOverrides: {
        redeemInvite: {
          kind: 'custom',
          handler: 'chat.invite.redeem',
          http: { method: 'post', path: 'redeem' },
        },
        claimInviteSlot: {
          kind: 'custom',
          handler: 'chat.invite.claimInviteSlot',
        },
        releaseInviteSlot: {
          kind: 'custom',
          handler: 'chat.invite.releaseInviteSlot',
        },
      },
    }),
    Reminder: entityConfigToManifestEntry(Reminder, {
      operations: reminderOperations.operations,
      operationOverrides: {
        claimDueReminders: {
          kind: 'custom',
          handler: 'chat.reminder.claimDueReminders',
        },
      },
    }),
  },
};

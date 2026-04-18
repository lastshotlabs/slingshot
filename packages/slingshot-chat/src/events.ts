import type {
  ChatMessageDeletedPayload,
  Message,
  MessageReaction,
  ReadReceiptCreatedPayload,
  Reminder,
  Room,
  RoomInvite,
  RoomMember,
} from './types';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'chat:room.created': Pick<Room, 'id' | 'type' | 'name'>;
    'chat:room.updated': Pick<Room, 'id'>;
    'chat:room.deleted': Pick<Room, 'id'>;
    'chat:room.archived': Pick<Room, 'id'>;
    'chat:room.unarchived': Pick<Room, 'id'>;
    'chat:room.favorited': { userId: string; roomId: string };
    'chat:room.unfavorited': { userId: string; roomId: string };
    'chat:member.added': Pick<RoomMember, 'id' | 'roomId' | 'userId' | 'role'>;
    'chat:member.updated': Pick<RoomMember, 'id' | 'roomId' | 'userId'>;
    'chat:member.removed': Pick<RoomMember, 'id' | 'roomId' | 'userId'>;
    'chat:message.created': Pick<Message, 'id' | 'roomId' | 'authorId' | 'type'>;
    'chat:message.updated': Pick<Message, 'id' | 'roomId'>;
    'chat:message.deleted': ChatMessageDeletedPayload;
    'chat:message.embeds.resolved': Pick<Message, 'id' | 'roomId' | 'embeds'>;
    'chat:message.scheduled.created': Pick<Message, 'id' | 'roomId' | 'authorId' | 'scheduledAt'>;
    'chat:message.scheduled.delivered': Message;
    'chat:message.reaction.added': MessageReaction;
    'chat:message.reaction.removed': MessageReaction;
    'chat:message.pinned': { id: string; roomId: string; messageId: string; pinnedBy: string };
    'chat:message.unpinned': { id: string; roomId: string; messageId: string };
    'chat:read.created': ReadReceiptCreatedPayload & { messageId: string; readAt: string };
    'chat:reminder.created': Pick<Reminder, 'id' | 'userId' | 'roomId' | 'triggerAt'>;
    'chat:reminder.triggered': Pick<Reminder, 'id' | 'userId' | 'roomId' | 'messageId' | 'note'>;
    'chat:invite.created': Pick<RoomInvite, 'id' | 'roomId' | 'token'>;
    'chat:user.blocked': { blockerId: string; blockedId: string };
    'chat:user.unblocked': { blockerId: string; blockedId: string };
  }
}

export {};

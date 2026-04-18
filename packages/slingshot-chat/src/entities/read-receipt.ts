// packages/slingshot-chat/src/entities/read-receipt.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a read receipt.
 *
 * Records that a specific user has read a specific message. Created or upserted
 * when the client sends a `chat.read` WebSocket event.
 *
 * @remarks
 * Key operations:
 * - `upsertReceipt`: Create or update a receipt for a user + message pair.
 * - `latestForUserInRoom`: Find the most recent receipt for a user in a room
 *   (used to compute unread counts).
 * - `listByMessage`: All users who have read a specific message.
 */
export const ReadReceipt = defineEntity('ReadReceipt', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    messageId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    roomId: field.string({ immutable: true }),
    readAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['userId', 'roomId']),
    index(['messageId']),
    index(['userId', 'messageId'], { unique: true }),
  ],
  uniques: [{ fields: ['userId', 'messageId'] }],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId' },
    get: { auth: 'userAuth' },
    list: { auth: 'userAuth' },
    create: {
      event: { key: 'chat:read.created', payload: ['id', 'messageId', 'userId', 'roomId'] },
    },
    update: { auth: 'none' },
    delete: { auth: 'none' },
    operations: {
      upsertReceipt: { auth: 'userAuth' },
      latestForUserInRoom: { auth: 'userAuth' },
      listByMessage: { auth: 'userAuth' },
    },
    clientSafeEvents: ['chat:read.created'],
  },
});

/**
 * Custom operations for the ReadReceipt entity.
 *
 * - `upsertReceipt`: Insert or update a receipt keyed on `(userId, messageId)`.
 * - `latestForUserInRoom`: Most recent receipt for a user in a room.
 * - `listByMessage`: All receipts for a specific message.
 */
export const readReceiptOperations = defineOperations(ReadReceipt, {
  upsertReceipt: op.upsert({
    match: ['userId', 'messageId'],
    set: ['readAt', 'roomId'],
  }),

  latestForUserInRoom: op.lookup({
    fields: { userId: 'param:userId', roomId: 'param:roomId' },
    returns: 'one',
  }),

  listByMessage: op.lookup({
    fields: { messageId: 'param:messageId' },
    returns: 'many',
  }),
});
